/**
 * Local MCP Gateway.
 *
 * Aggregates stdio MCP providers declared in two places:
 *
 *   1. User settings (codedock.externalProviders) - explicit user intent, always
 *      aggregated, spawned as configured.
 *   2. The workspace's .vscode/mcp.json (also accepts the Claude-style
 *      "mcpServers" key, JSONC comments tolerated) - a workspace file, so it is
 *      attacker-writable the moment the remote AI has edit permission. Those
 *      servers are only started when ALL of these hold:
 *        - codedock.aggregateWorkspaceMcp is not false
 *        - the Execute permission is ON (no process starts from a workspace
 *          file while the user has only granted read/edit)
 *        - the command line passes the destructive-command guard, and risky
 *          shapes ask the user first (same modal as run_command)
 *
 * Namespaces their tools as <provider>__<tool_name> so they can be discovered
 * and called through this single MCP endpoint without naming conflicts.
 * Settings entries win over same-named workspace entries; workspace names are
 * sanitized so the "__" separator stays unambiguous.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const readline = require("readline");
const vscode = require("vscode");
const scope = require("./scope");
const policy = require("./policy");
const guard = require("./guard");

class StdioMcpClient {
  constructor(providerConfig, log) {
    this.name = providerConfig.name;
    this.command = providerConfig.command;
    this.args = providerConfig.args || [];
    this.env = providerConfig.env || {};
    this.cwd = providerConfig.cwd;
    this.log = log || (() => {});

    this.child = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.ready = false;
    this.starting = false;
  }

  async start() {
    if (this.ready) return;
    if (this.starting) return;
    this.starting = true;

    try {
      const env = { ...process.env, ...this.env };
      const options = {
        cwd: this.cwd || undefined,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      };

      this.child = spawn(this.command, this.args, options);

      this.child.stderr.on("data", (chunk) => {
        this.log(`[mcp:${this.name}] ${chunk.toString("utf8").trim()}`);
      });

      this.child.on("error", (err) => {
        this.log(`[mcp:${this.name} error] ${err.message}`);
        this.teardown();
      });

      this.child.on("close", (code) => {
        this.log(`[mcp:${this.name} exited] code ${code}`);
        this.teardown();
      });

      this.rl = readline.createInterface({ input: this.child.stdout, terminal: false });
      this.rl.on("line", (line) => this.onLine(line));

      // MCP Initialize Handshake
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "CodeDock-Gateway", version: require("../package.json").version },
      });

      this.notify("notifications/initialized", {});

      const res = await this.request("tools/list", {});
      this.tools = (res && res.tools) || [];
      this.ready = true;
      this.log(`[mcp:${this.name}] connected with ${this.tools.length} tool(s)`);
    } catch (err) {
      this.log(`[mcp:${this.name} start failed] ${err.message}`);
      this.teardown();
      throw err;
    } finally {
      this.starting = false;
    }
  }

  onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 25000) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error(`Provider ${this.name} is not running`));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Request ${method} to provider ${this.name} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload + "\n");
    });
  }

  notify(method, params) {
    if (!this.child || !this.child.stdin.writable) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.child.stdin.write(payload + "\n");
  }

  async callTool(toolName, args) {
    if (!this.ready) await this.start();
    const result = await this.request("tools/call", { name: toolName, arguments: args || {} });
    return result;
  }

  teardown() {
    this.ready = false;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(`Provider ${this.name} terminated`));
    }
    this.pending.clear();
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
  }
}

/**
 * Remove // and /* ... *​/ comments outside string literals, so the JSONC that
 * editors happily write in .vscode/mcp.json still parses with JSON.parse.
 */
function stripJsonComments(text) {
  const source = String(text || "");
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] || "";
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The "__" separator between provider and tool must stay unambiguous, so a
 * workspace server name may not contain underscores runs or other noise.
 */
function sanitizeProviderName(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "mcp";
}

/**
 * Unwrap a provider's tools/call result into what the bridge's dispatcher
 * expects. A stdio provider answers with the full MCP shape
 * ({ content: [...], isError? }); handing that object up as-is made the
 * dispatcher JSON.stringify it into one opaque text blob - image blocks became
 * unusable and isError was silently dropped. Returning the content array keeps
 * every block type intact, and isError becomes a real thrown error.
 */
function unwrapExternalResult(result, label) {
  if (result && typeof result === "object" && Array.isArray(result.content)) {
    if (result.isError) {
      const message = result.content
        .map((part) => (part && part.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
      throw new Error(message || `external tool ${label} reported an error`);
    }
    return result.content;
  }
  return result;
}

/**
 * Read every workspace root's .vscode/mcp.json and return stdio server entries.
 * Accepts both the VS Code shape ("servers") and the Claude Desktop shape
 * ("mcpServers"); non-stdio servers (http/sse) are skipped with a log line.
 */
async function readWorkspaceServers(log) {
  const servers = [];
  for (const root of scope.roots()) {
    const file = path.join(root, ".vscode", "mcp.json");
    let text;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString("utf8");
    } catch {
      continue;
    }
    const display = scope.displayPath(file);

    let parsed;
    try {
      parsed = JSON.parse(stripJsonComments(text));
    } catch (err) {
      log(`[mcp-workspace] ${display} 解析失败：${err.message}`);
      continue;
    }

    const table =
      parsed && typeof parsed === "object" ? parsed.servers || parsed.mcpServers || null : null;
    if (!table || typeof table !== "object") continue;

    for (const [rawName, conf] of Object.entries(table)) {
      if (!conf || typeof conf !== "object" || typeof conf.command !== "string" || !conf.command.trim()) {
        continue;
      }
      if (conf.type && conf.type !== "stdio") {
        log(`[mcp-workspace] 跳过 ${rawName}（type=${conf.type}，只支持 stdio 服务器）`);
        continue;
      }
      const name = sanitizeProviderName(rawName);
      if (servers.some((existing) => existing.name === name)) {
        log(`[mcp-workspace] 服务器重名，忽略后出现的：${rawName}`);
        continue;
      }
      const args = Array.isArray(conf.args) ? conf.args.map(String) : [];
      const env = conf.env && typeof conf.env === "object" ? conf.env : {};
      const cwd = typeof conf.cwd === "string" && conf.cwd.trim() ? conf.cwd : undefined;
      const hash = crypto
        .createHash("sha256")
        .update(JSON.stringify({ root, rawName, command: conf.command, args, env, cwd }))
        .digest("hex")
        .slice(0, 16);
      servers.push({
        name,
        command: conf.command,
        args,
        env,
        cwd,
        source: "workspace",
        hash,
        label: rawName,
        display,
      });
    }
  }
  return servers;
}

class GatewayManager {
  constructor(options = {}) {
    this.providers = new Map();
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.customProviders = Array.isArray(options.providers) ? options.providers : null;
    /** Config hashes the user (or the guard) refused this session - do not re-ask. */
    this.rejectedWorkspaceHashes = new Set();
    /** Dedupes log lines across repeated tools/list calls. */
    this.lastSyncNote = "";
  }

  setLogSink(fn) {
    this.log = typeof fn === "function" ? fn : () => {};
    for (const p of this.providers.values()) {
      p.log = this.log;
    }
  }

  /** One log line per distinct situation, not one per tools/list call. */
  noteOnce(message) {
    if (message === this.lastSyncNote) return;
    this.lastSyncNote = message;
    this.log(message);
  }

  getConfiguredProviders() {
    if (this.customProviders) return this.customProviders;
    const cfg = vscode.workspace.getConfiguration("codedock");
    const raw = cfg.get("externalProviders");
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) => p && typeof p.name === "string" && typeof p.command === "string");
  }

  /**
   * Build the full provider list: settings entries first (trusted, win name
   * collisions), then approved workspace entries. Workspace entries additionally
   * need the Execute permission; a risky command line asks the user once and a
   * refusal is remembered for the session.
   */
  async resolveProviders() {
    const settingsList = this.getConfiguredProviders().map((p) => ({ ...p, source: "settings" }));
    const list = [...settingsList];
    const seen = new Set(settingsList.map((p) => p.name));

    const enabled = vscode.workspace.getConfiguration("codedock").get("aggregateWorkspaceMcp", true) !== false;
    if (!enabled) {
      this.noteOnce("[mcp-workspace] codedock.aggregateWorkspaceMcp 已关闭，不聚合 .vscode/mcp.json");
      return list;
    }

    const executeOn = policy.isAllowed("run_command");
    if (!executeOn) {
      this.noteOnce(
        "[mcp-workspace] 工作区 .vscode/mcp.json 里的 MCP 服务器未启动：需要先打开 Execute 权限（工作区文件可能声明任意进程）。"
      );
      return list;
    }

    const workspaceServers = await readWorkspaceServers(this.log);
    for (const server of workspaceServers) {
      if (seen.has(server.name)) {
        this.noteOnce(`[mcp-workspace] 与设置里的 externalProviders 重名，跳过：${server.name}`);
        continue;
      }
      if (this.rejectedWorkspaceHashes.has(server.hash)) continue;

      const commandLine = [server.command, ...(server.args || [])].join(" ").trim();
      const risks = guard.scan(commandLine);
      if (risks.length && !(await guard.confirm(commandLine, risks, server.display))) {
        this.rejectedWorkspaceHashes.add(server.hash);
        this.log(`[mcp-workspace] 已拒绝启动 ${server.label}（命中：${risks.join("；")}），本次会话内不再询问。`);
        continue;
      }
      seen.add(server.name);
      list.push(server);
    }
    return list;
  }

  async syncProviders() {
    const list = await this.resolveProviders();
    const activeNames = new Set(list.map((p) => p.name));

    for (const [name, client] of this.providers.entries()) {
      if (!activeNames.has(name)) {
        client.teardown();
        this.providers.delete(name);
      }
    }

    for (const conf of list) {
      if (!this.providers.has(conf.name)) {
        this.providers.set(conf.name, new StdioMcpClient(conf, this.log));
      }
    }
  }

  async listAggregatedTools() {
    await this.syncProviders();
    const aggregated = [];

    for (const [name, client] of this.providers.entries()) {
      try {
        if (!client.ready) await client.start();
        for (const t of client.tools) {
          aggregated.push({
            name: `${name}__${t.name}`,
            title: t.title ? `[${name}] ${t.title}` : `[${name}] ${t.name}`,
            description: `(External tool via ${name}) ${t.description || ""}`,
            inputSchema: t.inputSchema || { type: "object", properties: {} },
            isExternal: true,
            providerName: name,
            originalName: t.name,
            capability: "execute",
            async run(args) {
              return unwrapExternalResult(await client.callTool(t.name, args), t.name);
            },
          });
        }
      } catch (err) {
        this.log(`failed to list tools for external provider ${name}: ${err.message}`);
      }
    }

    return aggregated;
  }

  findTool(namespacedName) {
    // Split on the FIRST "__" only: provider names are sanitized and cannot
    // contain "__", but an external tool's own name may (provider "gh" +
    // tool "repo__get_file" -> "gh__repo__get_file"). A naive split() would
    // truncate the tool name and call the wrong tool.
    const sep = namespacedName.indexOf("__");
    if (sep <= 0) return null;
    const providerName = namespacedName.slice(0, sep);
    const origName = namespacedName.slice(sep + 2);
    if (!origName) return null;
    const client = this.providers.get(providerName);
    if (!client) return null;
    return {
      name: namespacedName,
      providerName,
      originalName: origName,
      capability: "execute",
      async run(args) {
        return unwrapExternalResult(await client.callTool(origName, args), origName);
      },
    };
  }

  disposeAll() {
    for (const client of this.providers.values()) {
      client.teardown();
    }
    this.providers.clear();
  }
}

const gateway = new GatewayManager();
gateway.GatewayManager = GatewayManager;
gateway.StdioMcpClient = StdioMcpClient;
gateway.stripJsonComments = stripJsonComments;
gateway.sanitizeProviderName = sanitizeProviderName;
gateway.unwrapExternalResult = unwrapExternalResult;
module.exports = gateway;

