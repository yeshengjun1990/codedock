/**
 * .NET toolchain.
 *
 * These are thin, well-named wrappers over `dotnet`. The value is not that they
 * can run a compiler - run_command could do that. It is that they resolve the
 * project for you, then hand back a *structured* list of diagnostics with
 * file/line/column instead of four hundred lines of MSBuild chatter. That is
 * what closes the loop: build → see exactly where the error is → patch → build.
 *
 * Every launch goes through runGuarded, so guard scanning, the workspace
 * boundary and the process registry apply exactly as they do to run_command.
 */

const vscode = require("vscode");
const scope = require("./scope");
const { runGuarded } = require("./tools-exec");

const MAX_DIAGNOSTICS = 200;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `src/Program.cs(12,5): error CS0103: The name 'foo' does not exist [C:\x.csproj]`
 *
 * Also matches the `(12,5,12,9)` four-number form MSBuild emits for some
 * analyzers, and tolerates the trailing project path.
 */
const DIAGNOSTIC_RE = /^(.*?)\((\d+),(\d+)(?:,\d+,\d+)?\):\s+(error|warning)\s+([A-Za-z]+\d+):\s+(.+?)(?:\s+\[[^\]]*\])?$/;

function parseDiagnostics(output) {
  const errors = [];
  const warnings = [];

  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = DIAGNOSTIC_RE.exec(line);
    if (!m) continue;

    const entry = {
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      code: m[5],
      message: m[6],
    };
    (m[4] === "error" ? errors : warnings).push(entry);
  }

  return { errors, warnings };
}

/** Workspace-relative display path, so diagnostics read short. */
function shortPath(file) {
  try {
    return scope.displayPath(file);
  } catch {
    return file;
  }
}

function renderDiagnostics({ errors, warnings }) {
  const lines = [];

  if (errors.length) {
    lines.push(`错误 (${errors.length})：`);
    for (const d of errors) {
      lines.push(`  ${shortPath(d.file)}:${d.line}:${d.column}  ${d.code}  ${d.message}`);
    }
  }
  if (warnings.length) {
    if (lines.length) lines.push("");
    lines.push(`警告 (${warnings.length})：`);
    for (const d of warnings) {
      lines.push(`  ${shortPath(d.file)}:${d.line}:${d.column}  ${d.code}  ${d.message}`);
    }
  }
  if (!lines.length) lines.push("没有解析到编译诊断。");

  const total = errors.length + warnings.length;
  if (total > MAX_DIAGNOSTICS) {
    lines.push("");
    lines.push(`（仅列出前 ${MAX_DIAGNOSTICS} 条，完整输出见下方原始日志）`);
  }
  return lines.join("\n");
}

/**
 * Shell-quote one argument for the shell run_command actually uses:
 * PowerShell on Windows (backtick escapes `$`, `` ` `` and `"` inside double
 * quotes - the old \" style let `$var` expand and `;` chain statements when a
 * value carried them), POSIX sh elsewhere (single quotes).
 */
function quote(value) {
  const text = String(value);
  if (process.platform === "win32") {
    if (!/[\s"'`$;&|()<>@,]/.test(text)) return text;
    return `"${text.replace(/([`"$])/g, "`$1")}"`;
  }
  if (!/[^\w@%+=:,./-]/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** Narrow free-text flag values instead of trusting quoting alone. */
function safeArg(value, label, re) {
  const text = String(value);
  if (!re.test(text)) {
    throw new Error(`${label} contains characters that are not allowed: ${JSON.stringify(text)}`);
  }
  return text;
}
const CONFIGURATION_RE = /^[A-Za-z0-9_.-]+$/;
const RUNTIME_RE = /^[A-Za-z0-9_.-]+$/;
const FILTER_RE = /^[\w.~!=&|()<>%*,+ -]+$/;

/** Every wrapper that waits synchronously can hit the ~85s transport cap. */
function timedOutNote(result) {
  return `[同步等待 ${result.timeoutMs} ms 后仍未结束，进程继续在后台运行（${result.id}）。用 get_command_output {"command_id":"${result.id}"} 读取后续输出，或用 cancel_command 停止。]`;
}

function dotnetExe() {
  return vscode.workspace.getConfiguration("codedock").get("dotnetPath", "") || "dotnet";
}

/**
 * Find the project to operate on.
 *
 * An explicit path always wins and is still checked against the workspace, so
 * the resolver never becomes a way around the boundary.
 */
async function resolveProject(explicit) {
  if (explicit) return scope.resolvePath(explicit);

  const found = await vscode.workspace.findFiles("**/*.{csproj,sln,fsproj}", "**/{node_modules,bin,obj}/**", 30);
  if (!found.length) {
    throw new Error(
      "No .NET project found in this workspace. Pass project explicitly, or open the folder that contains the .csproj/.sln."
    );
  }

  const sln = found.find((uri) => uri.fsPath.toLowerCase().endsWith(".sln"));
  const chosen = sln || found[0];
  return chosen.fsPath;
}

function buildResultText({ label, project, result, diagnostics }) {
  const status = result.exitCode === 0 ? "成功" : "失败";
  const seconds = (result.durationMs / 1000).toFixed(1);
  const header = `${label} — ${status}（退出码 ${result.exitCode}，耗时 ${seconds}s）\n项目：${shortPath(project)}`;

  const parts = [header, "", renderDiagnostics(diagnostics)];

  // The raw tail matters when the failure is not a compile error at all -
  // a missing SDK, a broken NuGet feed, an MSBuild target blowing up.
  const tail = String(result.output || "").trim();
  if (tail) {
    const clipped = tail.length > 6000 ? `…（前略）\n${tail.slice(-6000)}` : tail;
    parts.push("", "-".repeat(60), "原始输出（尾部）：", clipped);
  }
  if (result.timedOut) {
    parts.push("", `[超时 ${result.timeoutMs} ms，进程仍在运行。可以用 get_command_output 继续读取，或 cancel_command 停止。]`);
  }

  return parts.join("\n");
}

const TOOLS = [
  {
    name: "dotnet_detect",
    title: "Detect .NET SDK",
    description:
      "Report which .NET SDKs and runtimes are installed on this machine, and which project files exist in the workspace. Call this first when a build fails in a way that smells like a missing toolchain.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const sdk = await runGuarded({ command: `${quote(dotnetExe())} --list-sdks`, cwd: scope.primaryRoot() });
      const runtime = await runGuarded({
        command: `${quote(dotnetExe())} --list-runtimes`,
        cwd: scope.primaryRoot(),
      });

      const projects = await vscode.workspace.findFiles("**/*.{csproj,sln,fsproj}", "**/{node_modules,bin,obj}/**", 30);
      const sdkLines = String(sdk.output || "").trim();

      return [
        sdkLines ? `已安装 SDK：\n${sdkLines}` : "没有检测到 .NET SDK（`dotnet --list-sdks` 无输出）——可能没装，或不在 PATH 里。",
        "",
        String(runtime.output || "").trim() ? `运行时：\n${String(runtime.output).trim().split("\n").slice(0, 15).join("\n")}` : "",
        "",
        projects.length
          ? `工作区项目（${projects.length}）：\n${projects.map((uri) => `  ${scope.displayPath(uri.fsPath)}`).join("\n")}`
          : "工作区里没有 .csproj / .sln / .fsproj —— 当前打开的目录可能不是 .NET 项目根。",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },

  {
    name: "dotnet_build",
    title: "Build .NET Project",
    description:
      "Compile a .NET project and return structured diagnostics: every error and warning with file, line, column and code (e.g. src/Program.cs:12:5 CS0103 ...). Use this instead of run_command for compilation - the parsed list is what lets you jump straight to the broken line, fix it, and build again.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Path to a .csproj/.sln/.fsproj. Defaults to the solution, or the first project found." },
        configuration: { type: "string", description: "Debug (default) or Release." },
        timeout_ms: { type: "number", description: `Build timeout in ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output).` },
      },
    },
    async run(args) {
      const project = await resolveProject(args.project);
      const config = args.configuration ? ` -c ${quote(safeArg(args.configuration, "configuration", CONFIGURATION_RE))}` : "";
      const command = `${quote(dotnetExe())} build ${quote(project)} --nologo${config}`;

      const result = await runGuarded({
        command,
        cwd: scope.primaryRoot(),
        timeoutMs: Number(args.timeout_ms) || BUILD_TIMEOUT_MS,
      });

      return buildResultText({
        label: "dotnet build",
        project,
        result,
        diagnostics: parseDiagnostics(result.output),
      });
    },
  },

  {
    name: "dotnet_test",
    title: "Run .NET Tests",
    description:
      "Run the test suite for a .NET project and return the result summary plus any failing tests. Uses the project's own test framework (xunit / nunit / mstest) through `dotnet test`.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Path to a test .csproj/.sln. Defaults to the solution, or the first project found." },
        filter: { type: "string", description: "Optional test filter, e.g. FullyQualifiedName~PlayerTests." },
        timeout_ms: { type: "number", description: `Test timeout in ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output).` },
      },
    },
    async run(args) {
      const project = await resolveProject(args.project);
      const filter = args.filter ? ` --filter ${quote(safeArg(args.filter, "filter", FILTER_RE))}` : "";
      const command = `${quote(dotnetExe())} test ${quote(project)} --nologo${filter}`;

      const result = await runGuarded({
        command,
        cwd: scope.primaryRoot(),
        timeoutMs: Number(args.timeout_ms) || BUILD_TIMEOUT_MS,
      });

      const output = String(result.output || "");
      // `dotnet test` prints a summary block; keep it verbatim and add the
      // compile diagnostics when the failure was actually a build failure.
      const summaryLines = output
        .split(/\r?\n/)
        .filter((line) => /^(通过|失败|Passed!|Failed!|Total tests|Passed:|Failed:|Skipped:)/i.test(line.trim()))
        .slice(0, 20);

      const diagnostics = parseDiagnostics(output);
      const parts = [
        `dotnet test — ${result.exitCode === 0 ? "通过" : "有失败"}（退出码 ${result.exitCode}，耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
        `项目：${shortPath(project)}`,
        "",
      ];
      if (summaryLines.length) parts.push(summaryLines.join("\n"), "");
      if (diagnostics.errors.length) parts.push("编译错误（测试没跑起来）：", renderDiagnostics(diagnostics), "");

      const tail = output.trim();
      parts.push("-".repeat(60), "原始输出（尾部）：", tail.length > 8000 ? `…（前略）\n${tail.slice(-8000)}` : tail);
      if (result.timedOut) {
        parts.push("", timedOutNote(result));
      }
      return parts.join("\n");
    },
  },

  {
    name: "dotnet_run",
    title: "Run .NET Project",
    description:
      "Run a .NET project. Pass wait=false for a GUI app, server or anything long-running: you get a command_id back immediately, then poll get_command_output and stop it with cancel_command. Use wait=true only for console tools that exit on their own.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Path to the .csproj to run. Defaults to the first project found." },
        args: { type: "string", description: "Arguments passed through to the program." },
        configuration: { type: "string", description: "Debug (default) or Release." },
        wait: { type: "boolean", description: "Wait for exit. Default true; pass false for anything long-running." },
        timeout_ms: { type: "number", description: "When waiting, give up after this many ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output)." },
      },
    },
    async run(args) {
      const project = await resolveProject(args.project);
      const config = args.configuration ? ` -c ${quote(safeArg(args.configuration, "configuration", CONFIGURATION_RE))}` : "";
      const extra = args.args ? ` -- ${String(args.args)}` : "";
      const command = `${quote(dotnetExe())} run --project ${quote(project)}${config}${extra}`;

      const result = await runGuarded({
        command,
        cwd: scope.primaryRoot(),
        timeoutMs: args.timeout_ms,
        wait: args.wait !== false,
      });

      if (!result.waited) {
        return `已启动 ${result.id}（dotnet run --project ${shortPath(project)}）\n用 get_command_output {"command_id": "${result.id}"} 读取输出，cancel_command 停止。`;
      }

      const output = String(result.output || "");
      const diagnostics = parseDiagnostics(output);
      const parts = [
        `dotnet run — 退出码 ${result.exitCode}（耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
        "",
        "程序输出：",
        output.trim() || "(无输出)",
      ];
      if (diagnostics.errors.length) {
        parts.push("", "编译错误：", renderDiagnostics(diagnostics));
      }
      if (result.timedOut) {
        parts.push("", `[超时 ${result.timeoutMs} ms，进程仍在运行。它可能是个 GUI/服务程序，试试 wait=false。]`);
      }
      return parts.join("\n");
    },
  },

  {
    name: "dotnet_publish",
    title: "Publish .NET Project",
    description:
      "Publish a .NET project to a folder (framework-dependent by default). Set self_contained=true to bundle the runtime, and runtime to target a specific RID such as win-x64.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Path to the .csproj. Defaults to the first project found." },
        output: { type: "string", description: "Output folder, relative to the workspace root. Defaults to ./publish." },
        configuration: { type: "string", description: "Release (default for publish) or Debug." },
        runtime: { type: "string", description: "Target runtime identifier, e.g. win-x64 / linux-x64." },
        self_contained: { type: "boolean", description: "Bundle the .NET runtime into the output." },
        timeout_ms: { type: "number", description: `Publish timeout in ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output).` },
      },
    },
    async run(args) {
      const project = await resolveProject(args.project);
      const outDir = args.output ? scope.resolvePath(args.output) : scope.resolvePath("publish");

      const bits = [
        `${quote(dotnetExe())} publish ${quote(project)}`,
        `--nologo -c ${quote(safeArg(args.configuration || "Release", "configuration", CONFIGURATION_RE))}`,
        `-o ${quote(outDir)}`,
      ];
      if (args.runtime) bits.push(`-r ${quote(safeArg(args.runtime, "runtime", RUNTIME_RE))}`);
      bits.push(`--self-contained ${args.self_contained === true ? "true" : "false"}`);

      const result = await runGuarded({
        command: bits.join(" "),
        cwd: scope.primaryRoot(),
        timeoutMs: Number(args.timeout_ms) || BUILD_TIMEOUT_MS,
      });

      const diagnostics = parseDiagnostics(result.output);
      const text = buildResultText({ label: "dotnet publish", project, result, diagnostics });
      return result.exitCode === 0 ? `${text}\n\n输出目录：${shortPath(outDir)}` : text;
    },
  },

  {
    name: "dotnet_restore",
    title: "Restore .NET Dependencies",
    description:
      "Run `dotnet restore` for a project. Useful when a build fails on missing packages or a stale lock file, before reaching for heavier fixes.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Path to a .csproj/.sln. Defaults to the solution, or the first project found." },
        timeout_ms: { type: "number", description: `Restore timeout in ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output).` },
      },
    },
    async run(args) {
      const project = await resolveProject(args.project);
      const result = await runGuarded({
        command: `${quote(dotnetExe())} restore ${quote(project)} --nologo`,
        cwd: scope.primaryRoot(),
        timeoutMs: Number(args.timeout_ms) || BUILD_TIMEOUT_MS,
      });

      const output = String(result.output || "").trim();
      return [
        `dotnet restore — ${result.exitCode === 0 ? "成功" : "失败"}（退出码 ${result.exitCode}，耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
        `项目：${shortPath(project)}`,
        "",
        output.length > 4000 ? `…（前略）\n${output.slice(-4000)}` : output || "(无输出)",
      ]
        .concat(result.timedOut ? ["", timedOutNote(result)] : [])
        .join("\n");
    },
  },
];

module.exports = { TOOLS, parseDiagnostics };

