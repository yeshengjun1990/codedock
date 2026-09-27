/**
 * IDE tools - the reason this Bridge lives inside the editor instead of next to
 * it. Diagnostics and language-server navigation come from the live project
 * state, so the model sees real type errors and real symbol graphs rather than
 * guessing from raw text.
 */

const vscode = require("vscode");
const scope = require("./scope");

const SEVERITY_NAMES = ["Error", "Warning", "Info", "Hint"];
const SYMBOL_KIND_NAMES = [
  "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
  "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
  "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct",
  "Event", "Operator", "TypeParameter",
];

function kindName(kind) {
  return SYMBOL_KIND_NAMES[kind] || String(kind);
}

function formatLocation(location) {
  if (!location) return "(unknown)";
  // LocationLink carries targetUri/targetRange instead of uri/range.
  const uri = location.uri || location.targetUri;
  const range = location.range || location.targetSelectionRange || location.targetRange;
  const line = range ? range.start.line + 1 : 1;
  const col = range ? range.start.character + 1 : 1;
  return `${scope.displayPath(uri.fsPath)}:${line}:${col}`;
}

function flattenSymbols(symbols, depth = 0, out = []) {
  for (const symbol of symbols) {
    const line = symbol.range ? symbol.range.start.line + 1 : symbol.location ? symbol.location.range.start.line + 1 : 1;
    const where = symbol.location ? ` ${scope.displayPath(symbol.location.uri.fsPath)}` : "";
    out.push(`${"  ".repeat(depth)}${symbol.name} (${kindName(symbol.kind)})${where}:${line}`);
    if (symbol.children && symbol.children.length) {
      flattenSymbols(symbol.children, depth + 1, out);
    }
  }
  return out;
}

/** Latest todo snapshot, surfaced in the status bar by the extension entry. */
let todos = [];
let onTodosChanged = null;

function setTodosChangedHandler(handler) {
  onTodosChanged = handler;
}

function getTodos() {
  return todos;
}

/**
 * Latest live progress report, rendered as the big progress bar.
 *
 * Todos are the durable plan; this is the "what am I doing right now" layer the
 * client pushes between tool calls, optionally carrying a percentage.
 */
let progress = null;
let onProgressChanged = null;

function setProgressChangedHandler(handler) {
  onProgressChanged = handler;
}

function getProgress() {
  return progress;
}

function clearProgress() {
  progress = null;
}

function renderTodos(list) {
  if (!list.length) return "(no tasks)";
  return list
    .map((item) => {
      const mark = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
      return `${mark} ${item.id}. ${item.title}`;
    })
    .join("\n");
}

const TOOLS = [
  {
    name: "get_diagnostics",
    title: "Get Diagnostics",
    description:
      "Read compiler / linter diagnostics from the editor's language services - type errors, unresolved imports, unused variables and so on. Pass file_path for one file, or omit it for every open document. Use this after edits to check whether the change actually compiles.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Optional single file to inspect." },
        severity: {
          type: "string",
          enum: ["error", "warning", "info", "hint", "all"],
          description: "Minimum severity to report. Default all.",
        },
      },
    },
    async run(args) {
      const threshold = { error: 0, warning: 1, info: 2, hint: 3, all: 3 }[args.severity || "all"] ?? 3;
      const entries = [];
      const counts = { Error: 0, Warning: 0, Info: 0, Hint: 0 };

      const collect = (uri, diagnostics) => {
        for (const d of diagnostics) {
          if (d.severity > threshold) continue;
          const level = SEVERITY_NAMES[d.severity] || "";
          if (level in counts) counts[level] += 1;
          entries.push(
            `${scope.displayPath(uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
              `[${SEVERITY_NAMES[d.severity] || d.severity}] ${d.message}${d.source ? ` (${d.source})` : ""}`
          );
        }
      };

      if (args.file_path) {
        const uri = scope.toUri(args.file_path);
        await vscode.workspace.openTextDocument(uri);
        collect(uri, vscode.languages.getDiagnostics(uri));
      } else {
        const all = vscode.languages.getDiagnostics();
        for (const [uri, diagnostics] of all) {
          if (!scope.inScope(uri.fsPath)) continue;
          collect(uri, diagnostics);
        }
      }

      if (!entries.length) {
        return { text: "no diagnostics reported for the requested scope.", meta: { errors: 0, warnings: 0, infos: 0 } };
      }
      return {
        text: `${entries.length} diagnostic(s)\n${entries.join("\n")}`,
        meta: { errors: counts.Error, warnings: counts.Warning, infos: counts.Info + counts.Hint },
      };
    },
  },

  {
    name: "lsp",
    title: "Language Server",
    description:
      "Semantic code navigation through the editor's language servers. Prefer this over text search when locating symbols: an empty lsp result is meaningful, whereas a grep miss usually just means the wrong spelling. Operations: goToDefinition, findReferences, goToImplementation, documentSymbol, workspaceSymbol, hover.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: [
            "goToDefinition",
            "findReferences",
            "goToImplementation",
            "documentSymbol",
            "workspaceSymbol",
            "hover",
          ],
          description: "Which language-server query to run.",
        },
        file_path: { type: "string", description: "File to inspect (required except for workspaceSymbol)." },
        line: { type: "number", description: "1-based line number of the symbol." },
        column: { type: "number", description: "1-based column number of the symbol." },
        query: { type: "string", description: "Search query for workspaceSymbol." },
      },
    },
    async run(args) {
      const operation = args.operation;

      if (operation === "workspaceSymbol") {
        if (!args.query) throw new Error("query is required for workspaceSymbol");
        let symbols = (await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", args.query)) || [];
        symbols = symbols.filter((s) => s.location && scope.inScope(s.location.uri.fsPath));
        if (!symbols.length) return `no workspace symbol matched ${JSON.stringify(args.query)}`;
        return `${symbols.length} symbol(s)\n${flattenSymbols(symbols).join("\n")}`;
      }

      if (!args.file_path) throw new Error("file_path is required for " + operation);
      const uri = scope.toUri(args.file_path);
      const document = await vscode.workspace.openTextDocument(uri);

      const position =
        args.line && args.column
          ? new vscode.Position(Math.max(0, args.line - 1), Math.max(0, args.column - 1))
          : null;

      switch (operation) {
        case "documentSymbol": {
          const symbols = (await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)) || [];
          if (!symbols.length) return `no symbols found in ${scope.displayPath(uri.fsPath)}`;
          return flattenSymbols(symbols).join("\n");
        }

        case "goToDefinition":
        case "findReferences":
        case "goToImplementation": {
          if (!position) throw new Error("line and column are required for " + operation);
          const command = {
            goToDefinition: "vscode.executeDefinitionProvider",
            findReferences: "vscode.executeReferenceProvider",
            goToImplementation: "vscode.executeImplementationProvider",
          }[operation];
          const result = (await vscode.commands.executeCommand(command, uri, position)) || [];
          if (!result.length) {
            return `no ${operation} result at ${scope.displayPath(uri.fsPath)}:${args.line}:${args.column}. The symbol may be unresolved, or this language's server may not support the operation.`;
          }
          return `${result.length} result(s)\n${result.map(formatLocation).join("\n")}`;
        }

        case "hover": {
          if (!position) throw new Error("line and column are required for hover");
          const hovers = (await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position)) || [];
          if (!hovers.length) return "no hover information at that position.";
          const text = hovers
            .flatMap((h) => h.contents || [])
            .map((c) => (typeof c === "string" ? c : c.value || ""))
            .filter(Boolean)
            .join("\n");
          return text || "no hover information at that position.";
        }

        default:
          throw new Error(`unsupported operation: ${operation}`);
      }
    },
  },

  {
    name: "report_progress",
    title: "Report Progress",
    description:
      "Report what you are doing right now so the user can watch it in the editor: a short message, an optional phase label, and an optional completion percentage. Use set_todos for the durable task list and this for live status between tool calls. Call it when you start a meaningfully different step, not before every tool call.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string", description: "One line describing what is happening now." },
        phase: { type: "string", description: "Short phase label, for example 读取, 修改, 测试, 完成." },
        percent: { type: "integer", minimum: 0, maximum: 100, description: "Optional completion estimate for the current job." },
        todo_id: { type: "string", description: "Optional todo id from set_todos to attach this update to." },
      },
    },
    async run(args) {
      const message = String(args.message || "").trim();
      if (!message) throw new Error("message is required");

      const rawPercent = Number(args.percent);
      progress = {
        message,
        phase: args.phase ? String(args.phase) : "",
        percent: Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, Math.round(rawPercent))) : null,
        todoId: args.todo_id ? String(args.todo_id) : "",
        at: Date.now(),
      };

      if (onProgressChanged) onProgressChanged(progress);
      const suffix = progress.percent == null ? "" : ` (${progress.percent}%)`;
      return `进度已上报：${progress.phase ? `[${progress.phase}] ` : ""}${message}${suffix}`;
    },
  },

  {
    name: "set_todos",
    title: "Set Todos",
    description:
      "Publish the durable task list for the current job so the user can watch progress in the editor status bar. Send the full ordered list whenever the plan changes, keep at most one item in_progress, and use stable ids. Send an empty list to clear.",
    inputSchema: {
      type: "object",
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          description: "Complete ordered snapshot of the task list.",
          items: {
            type: "object",
            required: ["id", "title", "status"],
            properties: {
              id: { type: "string", description: "Stable id, reused across updates." },
              title: { type: "string", description: "Goal-level task title." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
          },
        },
      },
    },
    async run(args) {
      const list = Array.isArray(args.todos) ? args.todos : [];
      todos = list.map((item) => ({
        id: String(item.id),
        title: String(item.title),
        status: ["pending", "in_progress", "completed"].includes(item.status) ? item.status : "pending",
      }));
      if (onTodosChanged) onTodosChanged(todos);
      if (!todos.length) return "task list cleared.";
      const done = todos.filter((t) => t.status === "completed").length;
      return `task list updated: ${done}/${todos.length} completed\n${renderTodos(todos)}`;
    },
  },

  {
    name: "update_plan",
    title: "Update Plan",
    description:
      "Plan updater for clients that speak the Codex plan format ({ plan: [{ step, status }] }). It publishes to exactly the same task card as set_todos, so a Codex-style agent does not need a translation layer and the user sees one consistent list.",
    inputSchema: {
      type: "object",
      required: ["plan"],
      properties: {
        explanation: { type: "string", description: "Optional short reason for the change." },
        plan: {
          type: "array",
          description: "Complete ordered plan snapshot.",
          items: {
            type: "object",
            required: ["step", "status"],
            properties: {
              step: { type: "string", description: "Goal-level step title." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
          },
        },
      },
    },
    async run(args) {
      const plan = Array.isArray(args.plan) ? args.plan : [];
      todos = plan
        .map((item, index) => ({
          id: String(index + 1),
          title: String((item && item.step) || ""),
          status: ["pending", "in_progress", "completed"].includes(item && item.status) ? item.status : "pending",
        }))
        .filter((item) => item.title);

      if (onTodosChanged) onTodosChanged(todos);
      if (!todos.length) return "plan cleared.";
      const done = todos.filter((t) => t.status === "completed").length;
      return `plan updated: ${done}/${todos.length} completed\n${renderTodos(todos)}`;
    },
  },
];

module.exports = {
  TOOLS,
  setTodosChangedHandler,
  getTodos,
  renderTodos,
  setProgressChangedHandler,
  getProgress,
  clearProgress,
};
