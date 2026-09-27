/**
 * Workspace-defined tools.
 *
 * Drop JSON manifests into `.codedock/tools/*.json` and they show up as real MCP
 * tools next to the built-in ones, which is how a project teaches the agent its
 * own routines ("run the deploy script", "regenerate the schema") without the
 * agent having to rediscover them every session.
 *
 * Manifest:
 *   {
 *     "name": "run_tests",
 *     "title": "Run Tests",
 *     "description": "Run the project test suite",
 *     "command": "npm test -- {{file}}",
 *     "capability": "execute",
 *     "inputSchema": { "type": "object", "properties": { "file": { "type": "string" } } }
 *   }
 *
 * `{{placeholder}}` is replaced from the call arguments; a placeholder with no
 * matching argument fails the call instead of silently running a half-built
 * command.
 *
 * `capability` ("read" / "edit" / "execute") used to be honored as the tool's
 * gate level. It no longer is: a manifest is a workspace file, so the remote AI
 * can WRITE one as soon as it has edit permission, and a self-declared
 * `"capability": "read"` would let a shell template run while the user only
 * ever granted Read. Every manifest tool is therefore registered at Execute,
 * the strictest level, regardless of what it claims - a genuinely read-only
 * helper still works, it just needs the Execute switch like run_command does.
 */

const vscode = require("vscode");
const { spawn } = require("child_process");
const scope = require("./scope");
const policy = require("./policy");
const guard = require("./guard");
const { spawnOptions, killProcessTree } = require("./shell");

const MANIFEST_GLOB = ".codedock/tools/*.json";
const MAX_TOOLS = 50;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 200000;
/** Manifests are re-read lazily; a short cache keeps tools/list cheap. */
const CACHE_TTL_MS = 2000;

let cache = { at: 0, tools: [] };

function substitute(template, args) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = args[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(`missing argument "${key}" used by the command template`);
    }
    return Array.isArray(value) ? value.join(" ") : String(value);
  });
}

function runShell(command) {
  return new Promise((resolve, reject) => {
    const cwd = scope.primaryRoot();
    if (!cwd) {
      reject(new Error("No folder is open in this window."));
      return;
    }

    // The destructive-command gate is the second layer above Execute; a
    // manifest is a shell template just like run_command, so its commands go
    // through the same human confirmation instead of bypassing the guard.
    const risks = guard.scan(command);
    const gate = risks.length
      ? guard.confirm(command, risks, scope.displayPath(cwd))
      : Promise.resolve(true);

    gate.then((allowed) => {
      if (!allowed) {
        reject(
          new Error(
            `[user refused] This command matches high-risk patterns (${risks.join(
              "; "
            )}) and the user declined it in the editor.\nIt was NOT run. Do not retry it or a near variant - ask the user what they actually want instead.`
          )
        );
        return;
      }
      launch();
    });

    function launch() {
      // stdin stays closed: manifest tools are non-interactive by design.
      const child = spawn(command, spawnOptions({ cwd, stdio: ["ignore", "pipe", "pipe"] }));
      let output = "";
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => {
        killProcessTree(child).finally(() =>
          finish(reject, new Error(`custom tool timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s`))
        );
      }, RUN_TIMEOUT_MS);

      const collect = (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
      };

      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (err) => finish(reject, err));
      child.on("close", (code) => finish(resolve, `exit code ${code}\n${"-".repeat(60)}\n${output}`));
    }
  });
}

function buildTool(spec, uri, log) {
  const label = scope.displayPath(uri.fsPath);

  if (!spec || typeof spec !== "object") {
    log(`自定义工具清单不是对象：${label}`);
    return null;
  }
  if (typeof spec.name !== "string" || !/^[a-z][a-z0-9_]{1,48}$/i.test(spec.name)) {
    log(`自定义工具缺少合法 name：${label}`);
    return null;
  }
  if (typeof spec.command !== "string" || !spec.command.trim()) {
    log(`自定义工具 ${spec.name} 缺少 command：${label}`);
    return null;
  }

  // Registered at Execute no matter what the manifest claims: the manifest is a
  // workspace file, so its self-declared capability is attacker-writable and
  // must never LOWER the gate below what a shell template actually is.
  policy.register(spec.name, "execute");

  return {
    name: spec.name,
    title: spec.title || spec.name,
    description: spec.description || `Project tool defined in ${label}`,
    inputSchema:
      spec.inputSchema && typeof spec.inputSchema === "object"
        ? spec.inputSchema
        : { type: "object", properties: {} },
    custom: true,
    async run(args) {
      const command = substitute(spec.command, args || {});
      return await runShell(command);
    },
  };
}

/** Load and validate every manifest, with a short cache so listing stays cheap. */
async function loadCustomTools(log = () => {}) {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.tools;

  let uris = [];
  try {
    uris = await vscode.workspace.findFiles(MANIFEST_GLOB, null, MAX_TOOLS);
  } catch {
    return [];
  }

  const tools = [];
  const seen = new Set();
  for (const uri of uris) {
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const tool = buildTool(JSON.parse(text), uri, log);
      if (!tool) continue;
      if (seen.has(tool.name)) {
        log(`自定义工具名重复，忽略：${tool.name}（${scope.displayPath(uri.fsPath)}）`);
        continue;
      }
      seen.add(tool.name);
      tools.push(tool);
    } catch (err) {
      log(`自定义工具加载失败 ${scope.displayPath(uri.fsPath)}: ${err.message}`);
    }
  }

  // Forget capability assignments from manifests that have been deleted.
  policy.syncDeclared(tools.map((tool) => tool.name));

  cache = { at: now, tools };
  return tools;
}

function clearCache() {
  cache = { at: 0, tools: [] };
}

module.exports = { loadCustomTools, clearCache };

