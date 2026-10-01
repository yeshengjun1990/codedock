/**
 * MCP protocol handling.
 *
 * Handshake, tool listing and tool calls are answered statelessly: each POST
 * carries everything needed to answer it. That keeps web connectors happy, since
 * they cannot hold server-side session state across requests.
 */

const tools = require("./tools");

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";
/**
 * What the server calls itself in `initialize`.
 *
 * Note: this is NOT what shows up in ChatGPT's @ menu - that name is whatever
 * you typed when creating the connector. Keeping it equal to the name you use
 * there just avoids the "why does it call itself something else" confusion when
 * an agent lists servers or reports errors.
 */
const SERVER_NAME = "CodeDock";
/** Kept in lockstep with the extension manifest, so the handshake never lies. */
const SERVER_VERSION = require("../package.json").version;

function buildInstructions({ roots, extra }) {
  const scopeLines = roots.length
    ? roots.map((r) => `  - ${r}`).join("\n")
    : "  (no folder open)";

  const permissionLines = tools.policy
    .describe()
    .map((entry) => `- ${entry.label}: ${entry.enabled ? "ON" : "OFF"}`)
    .join("\n");

  const base = `You are connected to a live code editor window through its MCP bridge.

The workspace this window has open is your entire reachable scope:
${scopeLines}

Paths outside those folders are rejected. Relative paths are anchored at the first folder listed above.

The user grants this bridge three permission levels:
${permissionLines}

Calling a tool above a granted level is refused with "[permission denied]". When that happens, tell the user exactly which level to switch on in the CodeDock control panel and stop there - never attempt the same effect through a different tool.

Your edits go through the editor: they appear to the user as a reviewable diff and they can be undone with Ctrl+Z. Work accordingly - prefer several small, exact edits over rewriting a file.

Tools and when to use them:
- list_skills / read_skill: discover and read domain skills, architecture rules and conventions from the workspace (.agents/skills, .codex/skills, etc.). Call list_skills when starting any significant work.
- read_files: read a file before you touch it. Never edit from memory.
- apply_patch: exact-text edits (each old_text must match exactly once), full-file content, or file operations - delete:true removes a file, rename_to:"path" moves/renames it inside the workspace. All of it goes through the editor, so every change stays reviewable and undoable with Ctrl+Z. Use enough surrounding context to stay unambiguous.
- find_files: discover structure by glob instead of guessing paths.
- list_directory: look at exactly one directory level, directories first.
- search_files: raw text/regex search. Use it for strings and config values.
- read_image: actually see a png/jpg/gif/webp (mockup, diagram, photo). The image is brought into the conversation, so describe what is there instead of guessing from the filename.
- lsp: semantic navigation - goToDefinition, findReferences, goToImplementation, documentSymbol, workspaceSymbol, hover. Prefer this over search_files when locating code symbols; an empty result is meaningful, a grep miss usually is not.
- get_diagnostics: after meaningful edits, check the language server's errors and warnings for the files you touched. This is how you verify your own change compiles.
- run_command: build, test, run scripts. Set wait=false for servers, watchers and anything long-running, then poll get_command_output and stop it with cancel_command.
- list_jobs / get_command_output / cancel_command / send_command_input: list background tasks, incremental/cursor output polling, stopping, and answering interactive prompts of a command started with wait=false. None of them ever queue, so long-running commands can always be inspected or stopped.
- git_status / git_diff / git_log / git_show / git_branch: read-level git inspection - parsed status, unified diffs, history. git_stage / git_commit / git_checkout rewrite local repository state and need Edit. git_push / git_pull touch the network and need Execute. Force pushes, hard resets and other history-destroying forms are NOT available here on purpose - they only work through run_command, where the user is asked explicitly.
- dotnet_detect / dotnet_build / dotnet_test / dotnet_run / dotnet_publish / dotnet_restore: structured .NET toolchain wrappers. dotnet_build and dotnet_test parse errors into file:line:column CS-code lists; prefer them over run_command for compile/test loops. They need Execute permission.
- godot_detect / godot_import / godot_run / godot_export / godot_check: Godot engine wrappers. Godot often exits 0 even when a script fails, so godot_check parses ERROR/SCRIPT ERROR lines instead of trusting the exit code. Run godot_import once before the first run on a fresh checkout. They need Execute permission; godotPath is configurable.
- set_todos: publish the ordered task list for multi-step work. Keep at most one item in_progress and reuse stable ids. Send an empty list to clear it.
- update_plan: the same task card in Codex plan format ({ plan: [{ step, status }] }). Use whichever of the two matches your client; both publish to one list, so do not use both at once.
- report_progress: say what you are doing right now - a short message, an optional phase label, and an optional 0-100 percent. The editor renders this as a progress bar the user watches, so call it when you move to a meaningfully different step rather than before every tool call.

Working rules:
- Check list_skills first to align with project-specific architecture, rules and guidelines.
- Read before editing; re-read after a failed patch instead of guessing.
- Verify with get_diagnostics and a real command (test/build) before claiming success.
- Report exactly which files changed and what the diff was.
- If a tool errors, say so plainly. Never invent file contents or command output.
- Credential material (.env, private keys, .npmrc and the like) is refused by read_files and excluded from search_files by default. If a value from one of them is genuinely needed, ask the user to paste it - do not try to reach it through another tool.`;

  return extra ? `${base}\n\nAdditional instructions from the user:\n${extra}` : base;
}

/**
 * Who has docked here recently.
 *
 * Every MCP client announces itself in `initialize` via clientInfo. The HTTP
 * transport is stateless - requests carry no per-connection identity - so the
 * honest thing to track is "which clients handshook recently", not "who is
 * connected right now". The panel shows this list; it turns "something is
 * calling my tools" into "ChatGPT called my tools 2 minutes ago".
 */
const CLIENT_TTL_MS = 30 * 60 * 1000;
const clients = new Map(); // "name@version" -> { name, version, firstSeen, lastSeen }

function noteClient(info) {
  const name = typeof info?.name === "string" ? info.name.trim().slice(0, 60) : "";
  if (!name) return null;
  const version = typeof info?.version === "string" ? info.version.trim().slice(0, 30) : "?";
  const key = `${name}@${version}`;
  const now = Date.now();
  const existing = clients.get(key);
  if (existing) {
    existing.lastSeen = now;
    return { key, isNew: false, name, version };
  }
  clients.set(key, { name, version, firstSeen: now, lastSeen: now });
  return { key, isNew: true, name, version };
}

/** Clients seen inside the TTL window, most recent first. */
function recentClients() {
  const cutoff = Date.now() - CLIENT_TTL_MS;
  for (const [key, entry] of clients) {
    if (entry.lastSeen < cutoff) clients.delete(key);
  }
  return [...clients.values()].sort((a, b) => b.lastSeen - a.lastSeen).map(({ name, version, lastSeen }) => ({ name, version, lastSeen }));
}

function createDispatcher(context) {
  const { roots, extraInstructions, log } = context;

  // Workspace-declared tools report their problems through the same channel.
  tools.setLogSink(log);

  async function handle(message) {
    const method = message.method;
    const params = message.params || {};

    if (method === "initialize") {
      const requested = params.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      const noted = noteClient(params.clientInfo);
      if (noted && noted.isNew) {
        log(`客户端接入：${noted.name}${noted.version !== "?" ? ` v${noted.version}` : ""}`);
      }
      return {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: buildInstructions({ roots: roots(), extra: extraInstructions() }),
      };
    }

    if (method === "ping") return {};

    if (method === "tools/list") {
      return { tools: await tools.listTools() };
    }

    if (method === "tools/call") {
      const name = params.name;
      if (typeof name !== "string" || !name) {
        throw Object.assign(new Error("tools/call requires a string \"name\""), { code: -32602 });
      }
      log(`tool call: ${name}`);
      return await tools.callTool(name, params.arguments);
    }

    if (typeof method !== "string") {
      const detail = method === undefined ? "method is required" : "method must be a string";
      throw Object.assign(new Error(`invalid request: ${detail}`), { code: -32600 });
    }

    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }

  return { handle };
}

module.exports = {
  createDispatcher,
  buildInstructions,
  LATEST_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  recentClients,
};

