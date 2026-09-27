/**
 * Godot toolchain.
 *
 * Godot is a single executable that does everything - import, run, export,
 * headless smoke-test - so these tools are mostly about finding that binary,
 * finding project.godot, and translating the engine's output into something a
 * model can act on.
 *
 * Two Godot quirks shape the design:
 *   - It often exits 0 even when a script failed, so success is decided by
 *     scanning the output for ERROR lines, not by the exit code alone.
 *   - The first run of a project imports assets and can take minutes on a big
 *     one, which is why godot_import is its own tool rather than a hidden step.
 *
 * Every launch goes through runGuarded, so guard scanning, the workspace
 * boundary and the process registry apply exactly as they do to run_command.
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const scope = require("./scope");
const { runGuarded } = require("./tools-exec");

const GODOT_TIMEOUT_MS = 15 * 60 * 1000;

/** A synchronous wait can hit the transport's ~85s cap; the run continues. */
function timedNote(result) {
  return `[同步等待 ${result.timeoutMs} ms 后 Godot 仍在运行（${result.id}）。用 get_command_output {"command_id":"${result.id}"} 继续读取，或用 cancel_command 停止。]`;
}

/**
 * Shell-quote one argument for the shell run_command actually uses:
 * PowerShell on Windows (backtick escaping - the old \" style let `$var`
 * expand and `;` chain statements), POSIX sh elsewhere (single quotes).
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

/**
 * Locate the Godot binary.
 *
 * Order: explicit setting, then PATH, then a portable copy sitting next to the
 * project (which is how people who keep several engine versions side by side
 * usually work). Nothing here scans the whole disk - a wrong guess costs more
 * than the error message does.
 */
async function resolveGodot() {
  const configured = vscode.workspace.getConfiguration("codedock").get("godotPath", "");
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(`codedock.godotPath points at something that does not exist: ${configured}`);
    }
    return configured;
  }

  // The shell on Windows is PowerShell (not cmd.exe), so this must be
  // PowerShell syntax; `where ... 2>nul || ...` would fail there.
  const lookup =
    process.platform === "win32"
      ? "(Get-Command godot,godot4 -ErrorAction SilentlyContinue | Select-Object -First 1).Source"
      : "command -v godot || command -v godot4";
  const fromPath = await runGuarded({
    command: lookup,
    cwd: scope.primaryRoot(),
  });
  const hit = String(fromPath.output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && /godot/i.test(line) && fs.existsSync(line));
  if (hit) return hit;

  const exePattern = process.platform === "win32" ? /^godot.*\.exe$/i : /^godot/i;
  const roots = scope.roots();
  for (const root of roots) {
    const nearby = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && exePattern.test(entry.name))
      .map((entry) => path.join(root, entry.name))
      .filter((file) => {
        try {
          return process.platform === "win32" || fs.statSync(file).isFile();
        } catch {
          return false;
        }
      });
    if (nearby.length) return nearby[0];
  }

  throw new Error(
    [
      "找不到 Godot 可执行文件。",
      "",
      "两种解决办法：",
      "  1. 在设置里填 codedock.godotPath，例如 C:\\Godot\\Godot_v4.3-stable_win64.exe",
      "  2. 把 godot 加进 PATH",
      "",
      "（Godot 是绿色软件，路径随版本变化，所以这里不猜。）",
    ].join("\n")
  );
}

/** Find project.godot, honouring an explicit path under the workspace rule. */
async function resolveProject(explicit) {
  if (explicit) {
    const resolved = scope.resolvePath(explicit);
    // Accept either the project folder or the project.godot file itself.
    if (resolved.toLowerCase().endsWith("project.godot")) return path.dirname(resolved);
    return resolved;
  }

  const found = await vscode.workspace.findFiles("**/project.godot", "**/{.godot,node_modules}/**", 20);
  if (!found.length) {
    throw new Error("这个工作区里没有 project.godot —— 当前打开的目录不是 Godot 项目根。");
  }
  return path.dirname(found[0].fsPath);
}

/** `ERROR: ...` / `SCRIPT ERROR: ...` / `WARNING: ...` plus their `at:` line. */
function parseEngineMessages(output) {
  const errors = [];
  const warnings = [];
  const lines = String(output || "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isError = /^(SCRIPT )?ERROR:/i.test(line) || /^Parse Error:/i.test(line);
    const isWarning = /^WARNING:/i.test(line);
    if (!isError && !isWarning) continue;

    const next = (lines[i + 1] || "").trim();
    const at = /at:\s*(.+?)\s*\((.*?):(\d+)\)/.exec(next) || /at:\s*(.+)$/.exec(next);
    const entry = {
      message: line.replace(/\s+/g, " "),
      location: at ? (at[3] ? `${at[2]}:${at[3]}` : at[1]) : "",
    };
    (isError ? errors : warnings).push(entry);
  }

  return { errors, warnings };
}

function renderMessages({ errors, warnings }) {
  const parts = [];
  if (errors.length) {
    parts.push(`引擎报错 (${errors.length})：`);
    for (const e of errors.slice(0, 40)) parts.push(`  ${e.message}${e.location ? `\n      → ${e.location}` : ""}`);
  }
  if (warnings.length) {
    if (parts.length) parts.push("");
    parts.push(`警告 (${warnings.length})：`);
    for (const w of warnings.slice(0, 20)) parts.push(`  ${w.message}${w.location ? `\n      → ${w.location}` : ""}`);
  }
  return parts.join("\n");
}

/** Export presets declared in export_presets.cfg, so the model need not guess names. */
function readExportPresets(projectDir) {
  const file = path.join(projectDir, "export_presets.cfg");
  if (!fs.existsSync(file)) return [];
  try {
    const text = fs.readFileSync(file, "utf8");
    const presets = [];
    for (const block of text.split(/^\[preset\.\d+\]$/m).slice(1)) {
      const name = /^\s*name="(.+?)"/m.exec(block);
      const platform = /^\s*platform="(.+?)"/m.exec(block);
      if (name) presets.push({ name: name[1], platform: platform ? platform[1] : "" });
    }
    return presets;
  } catch {
    return [];
  }
}

const TOOLS = [
  {
    name: "godot_detect",
    title: "Detect Godot",
    description:
      "Report the Godot version found on this machine, the project.godot in this workspace, and the export presets declared for it. Call this before running or exporting, so you know which engine build and which preset names you are working with.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const godot = await resolveGodot();
      const version = await runGuarded({ command: `${quote(godot)} --version`, cwd: scope.primaryRoot() });
      // detect must still answer when the folder is not a Godot project, so
      // the engine version is discoverable before the user opens the right one.
      let projectLine = "项目：(当前工作区里没有 project.godot)";
      let presets = [];
      let importedLine = "资源已导入：(无项目)";
      try {
        const projectDir = await resolveProject();
        presets = readExportPresets(projectDir);
        const godotDir = path.join(projectDir, ".godot");
        projectLine = `项目：${scope.displayPath(projectDir)}`;
        importedLine = `资源已导入：${fs.existsSync(godotDir) ? "是" : "否（首次运行前先调 godot_import）"}`;
      } catch {}

      return [
        `Godot：${godot}`,
        `版本：${String(version.output || "").trim() || "(未知)"}`,
        projectLine,
        importedLine,
        "",
        !projectLine.includes("project.godot")
          ? ""
          : presets.length
            ? `导出预设（${presets.length}）：\n${presets.map((p) => `  ${p.name}${p.platform ? `  [${p.platform}]` : ""}`).join("\n")}`
            : "export_presets.cfg 里没有导出预设 —— 导出前需要在 Godot 编辑器里配一次（项目 → 导出）。",
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  },

  {
    name: "godot_import",
    title: "Import Godot Assets",
    description:
      "Run Godot's headless asset import for the project. Do this after adding or changing assets, and always before the first run on a fresh checkout - otherwise the engine reports missing resources even though the files are right there.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project folder or project.godot path. Defaults to the one found in the workspace." },
        timeout_ms: { type: "number", description: `Import timeout in ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output).` },
      },
    },
    async run(args) {
      const godot = await resolveGodot();
      const projectDir = await resolveProject(args.project);

      const result = await runGuarded({
        command: `${quote(godot)} --path ${quote(projectDir)} --headless --import`,
        cwd: projectDir,
        timeoutMs: Number(args.timeout_ms) || GODOT_TIMEOUT_MS,
      });

      const messages = parseEngineMessages(result.output);
      const output = String(result.output || "").trim();

      return [
        `godot --import — ${messages.errors.length ? "有报错" : "完成"}（退出码 ${result.exitCode}，耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
        "",
        renderMessages(messages) || "导入过程没有报错。",
        "",
        "-".repeat(60),
        output.length > 5000 ? `…（前略）\n${output.slice(-5000)}` : output || "(无输出)",
        ...(result.timedOut ? ["", timedNote(result)] : []),
      ].join("\n");
    },
  },

  {
    name: "godot_run",
    title: "Run Godot Project",
    description:
      "Launch the Godot project. For a real playable window leave wait=false and read output with get_command_output. For a headless smoke run (CI-style, no window) pass headless=true and quit_after=<frames>.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project folder or project.godot path. Defaults to the one found in the workspace." },
        headless: { type: "boolean", description: "Run without a window (no rendering). Pair with quit_after." },
        quit_after: { type: "number", description: "Quit automatically after this many frames. Useful for a quick headless check." },
        scene: { type: "string", description: "Optional scene to run instead of the main scene, e.g. res://test/TestScene.tscn." },
        wait: { type: "boolean", description: "Wait for exit. Default false - a game window does not exit on its own." },
        timeout_ms: { type: "number", description: "When waiting, give up after this many ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output)." },
      },
    },
    async run(args) {
      const godot = await resolveGodot();
      const projectDir = await resolveProject(args.project);

      const bits = [`${quote(godot)}`, `--path ${quote(projectDir)}`];
      if (args.headless) bits.push("--headless");
      if (args.quit_after) bits.push(`--quit-after ${Number(args.quit_after)}`);
      if (args.scene) bits.push(quote(args.scene));

      // A windowed game only exits when quit_after is set; waiting otherwise
      // would just burn the timeout.
      const shouldWait = args.wait === true || Boolean(args.quit_after);

      const result = await runGuarded({
        command: bits.join(" "),
        cwd: projectDir,
        timeoutMs: args.timeout_ms,
        wait: shouldWait,
      });

      if (!result.waited) {
        const presets = readExportPresets(projectDir);
        return [
          `已启动 Godot：${result.id}`,
          `项目：${scope.displayPath(projectDir)}`,
          presets.length ? "" : "",
          "",
          "接下来可以：",
          `  - 用 get_command_output {"command_id": "${result.id}"} 读引擎输出`,
          `  - 用 cancel_command {"command_id": "${result.id}"} 关掉它`,
        ]
          .filter(Boolean)
          .join("\n");
      }

      const messages = parseEngineMessages(result.output);
      const output = String(result.output || "").trim();
      return [
        `godot run — 退出码 ${result.exitCode}（耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
        "",
        renderMessages(messages) || "运行期间没有报错。",
        "",
        "-".repeat(60),
        output.length > 6000 ? `…（前略）\n${output.slice(-6000)}` : output || "(无输出)",
        ...(result.timedOut ? ["", timedNote(result)] : []),
      ].join("\n");
    },
  },

  {
    name: "godot_export",
    title: "Export Godot Build",
    description:
      "Export the project to a runnable build using one of its export presets. Call godot_detect first to see the preset names - the name must match export_presets.cfg exactly. Runs headless, so no editor window is needed.",
    inputSchema: {
      type: "object",
      required: ["preset"],
      properties: {
        preset: { type: "string", description: "Export preset name, exactly as written in export_presets.cfg (e.g. Windows Desktop)." },
        output: { type: "string", description: "Output file path, relative to the workspace root (e.g. build/game.exe)." },
        project: { type: "string", description: "Project folder or project.godot path. Defaults to the one found in the workspace." },
        debug: { type: "boolean", description: "Export a debug build instead of release." },
        timeout_ms: { type: "number", description: `Export timeout in ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output).` },
      },
    },
    async run(args) {
      const godot = await resolveGodot();
      const projectDir = await resolveProject(args.project);
      const presets = readExportPresets(projectDir);

      const wanted = String(args.preset);
      const match = presets.find((p) => p.name === wanted);
      if (!match) {
        if (!presets.length) {
          throw new Error(
            "项目里没有 export_presets.cfg 或里面没有任何导出预设。先在 Godot 编辑器里配一次（项目 → 导出），再调用 godot_export。"
          );
        }
        throw new Error(
          `没有名为 "${wanted}" 的导出预设。\n\n这个项目有：\n${presets.map((p) => `  - ${p.name}`).join("\n")}\n\n` +
            "预设名必须和 export_presets.cfg 里完全一致。先调 godot_detect 查看可用预设名。"
        );
      }

      const defaultExt = match && /windows/i.test(match.platform) ? ".exe" : "";
      const outFile = args.output
        ? scope.resolvePath(args.output)
        : scope.resolvePath(path.join("build", `${wanted.replace(/[^\w.-]+/g, "_")}${defaultExt}`));

      fs.mkdirSync(path.dirname(outFile), { recursive: true });

      const flag = args.debug ? "--export-debug" : "--export-release";
      const result = await runGuarded({
        command: `${quote(godot)} --path ${quote(projectDir)} --headless ${flag} ${quote(wanted)} ${quote(outFile)}`,
        cwd: projectDir,
        timeoutMs: Number(args.timeout_ms) || GODOT_TIMEOUT_MS,
      });

      const messages = parseEngineMessages(result.output);
      const output = String(result.output || "").trim();
      const produced = fs.existsSync(outFile);
      const sizeMb = produced ? (fs.statSync(outFile).size / 1024 / 1024).toFixed(1) : null;

      return [
        `godot export（${wanted}）— ${produced ? "已产出" : "没有产出文件"}（退出码 ${result.exitCode}，耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
        produced ? `输出：${scope.displayPath(outFile)}  (${sizeMb} MB)` : `预期输出：${scope.displayPath(outFile)}`,
        "",
        renderMessages(messages) ||
          (produced
            ? "导出过程没有报错。"
            : "没有错误信息也没有产物 —— 检查预设里的「导出路径」是不是设成了「询问」；headless 导出必须预先写死一个固定路径。"),
        "",
        "-".repeat(60),
        output.length > 5000 ? `…（前略）\n${output.slice(-5000)}` : output || "(无输出)",
        ...(result.timedOut ? ["", timedNote(result)] : []),
      ].join("\n");
    },
  },

  {
    name: "godot_check",
    title: "Smoke-Test Godot Project",
    description:
      "Run the project headless for a few frames and report any script or resource errors. This is the cheapest way to answer 'does it still load?' after edits, without opening a window or waiting for a human to click anything.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project folder or project.godot path. Defaults to the one found in the workspace." },
        frames: { type: "number", description: "How many frames to run before quitting (default 120, roughly two seconds)." },
        scene: { type: "string", description: "Optional scene to load instead of the main scene." },
        timeout_ms: { type: "number", description: "Hard timeout in ms (the synchronous wait is capped at 85s; past that the process keeps running and can be polled with get_command_output)." },
      },
    },
    async run(args) {
      const godot = await resolveGodot();
      const projectDir = await resolveProject(args.project);
      const frames = Number(args.frames) || 120;

      const bits = [`${quote(godot)}`, `--path ${quote(projectDir)}`, "--headless", `--quit-after ${frames}`];
      if (args.scene) bits.push(quote(args.scene));

      const result = await runGuarded({
        command: bits.join(" "),
        cwd: projectDir,
        timeoutMs: Number(args.timeout_ms) || 180000,
      });

      const messages = parseEngineMessages(result.output);
      const output = String(result.output || "").trim();
      const clean = messages.errors.length === 0 && result.exitCode === 0;

      return [
        `godot --headless --quit-after ${frames} — ${clean ? "干净通过" : "有问题"}（退出码 ${result.exitCode}，耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
        "",
        renderMessages(messages) || "这几帧里没有任何脚本或资源报错。",
        "",
        "-".repeat(60),
        output.length > 6000 ? `…（前略）\n${output.slice(-6000)}` : output || "(无输出)",
        ...(result.timedOut ? ["", timedNote(result)] : []),
      ].join("\n");
    },
  },
];

module.exports = { TOOLS, parseEngineMessages, readExportPresets };

