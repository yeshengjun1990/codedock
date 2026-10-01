/**
 * CodeDock - VS Code extension entry point.
 *
 * Turns the open window into an MCP server that web AI clients can reach over a
 * tunnel, using the language services and edit pipeline of the editor itself.
 * Scope is exactly the folders open in this window.
 *
 * Two UI surfaces share one document: an activity-bar view for everyday use and
 * an editor-area panel when there is more room to show everything at once.
 */

const vscode = require("vscode");
const crypto = require("crypto");

const scope = require("./lib/scope");
const { createHttpServer } = require("./lib/server");
const { createDispatcher, recentClients } = require("./lib/protocol");
const { TunnelManager } = require("./lib/tunnel");
const { renderPanelHtml } = require("./lib/panel");
const { buildConnectionPrompt } = require("./lib/prompt");
const tools = require("./lib/tools");
const execTools = require("./lib/tools-exec");
const ideTools = require("./lib/tools-ide");
const policy = require("./lib/policy");
const metrics = require("./lib/metrics");
const license = require("./lib/license");
const gateway = require("./lib/gateway");

const TOKEN_SECRET_KEY = "codedock.routeToken";
const MAX_LOG_LINES = 200;
const CONFIG_KEYS = [
  "port",
  "tunnelProvider",
  "cloudflaredPath",
  "ngrokPath",
  "ngrokConfigPath",
  "ngrokAuthtoken",
  "ngrokDomain",
  "cloudflareTunnelToken",
  "cloudflareHostname",
  "sendImages",
  "dotnetPath",
  "godotPath",
  "extraInstructions",
  "autoStart",
  "routeToken",
  "externalProviders",
  "openaiTunnelId",
  "openaiApiKey",
  "openaiTunnelClientPath",
];

/** Changing any of these needs the tunnel rebuilt; the rest is hot-swappable. */
const TUNNEL_KEYS = [
  "port",
  "tunnelProvider",
  "cloudflaredPath",
  "ngrokPath",
  "ngrokConfigPath",
  "ngrokAuthtoken",
  "ngrokDomain",
  "cloudflareTunnelToken",
  "cloudflareHostname",
  "openaiTunnelId",
  "openaiApiKey",
  "openaiTunnelClientPath",
];

/**
 * Short badge for the activity feed, built from a tool's structured meta.
 * Unlike parsing the rendered text, this cannot break when wording changes.
 */
function metaLabel(name, meta) {
  if (!meta) return "";
  // A replayed call ran nothing - say that before any tool-specific badge.
  if (meta.replayed) return "重放";
  if (name === "apply_patch") {
    if (meta.deleted) return "已删除";
    if (meta.renamed_from) return `重命名自 ${meta.renamed_from}`;
    const parts = [];
    if (meta.added) parts.push(`+${meta.added}`);
    if (meta.removed) parts.push(`−${meta.removed}`);
    return parts.join(" ");
  }
  if (name === "get_diagnostics") {
    if (meta.errors) return `${meta.errors} 错误`;
    if (meta.warnings) return `${meta.warnings} 告警`;
    return "clean";
  }
  if (meta.files != null) return `${meta.files} 文件`;
  if (meta.matches != null) return `${meta.matches} 匹配`;
  if (meta.count != null) {
    if (name === "list_skills") return `${meta.count} 技能`;
    if (name === "list_jobs") return `${meta.count} 任务`;
    return `${meta.count} 项`;
  }
  if (meta.background) return "后台运行";
  return "";
}

class BridgeController {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("CodeDock");
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBar.command = "codedock.openPanel";
    this.todosBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 89);
    this.todosBar.command = "codedock.openPanel";

    this.server = null;
    this.tunnel = null;
    this.publicUrl = null;
    this.routeToken = null;
    this.port = null;
    this.running = false;
    this.busy = false;
    this.tunnelMessage = "";
    this.logs = [];
    this.health = null;
    this.healthTimer = null;

    /** Live feed of the tool calls the remote client is making. */
    this.activities = [];
    this.activeTool = null;
    this.stats = { calls: 0, failed: 0, totalMs: 0 };
    this.lastMetric = null;
    tools.setObserver((event) => this.onToolActivity(event));
    tools.setLogSink((msg) => this.log(msg));

    /** @type {Set<import("vscode").Webview>} */
    this.webviews = new Set();
    this.broadcastTimer = null;
    this.editorPanel = null;

    ideTools.setTodosChangedHandler((todos) => this.renderTodos(todos));
    ideTools.setProgressChangedHandler(() => {
      this.updateStatusBar();
      this.scheduleBroadcast();
    });
    this.renderIdle();
  }

  onMetric(record) {
    this.lastMetric = record;
    if (this.activities.length) {
      const match = this.activities.find((a) => a.name === record.tool && a.serviceMs == null);
      if (match) {
        match.gapMs = record.gapMs;
        match.serviceMs = record.serviceMs;
      }
    }
    this.scheduleBroadcast();
  }

  // ---------------------------------------------------------------- logging

  log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    this.output.appendLine(line);
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
    this.scheduleBroadcast();
  }

  /**
   * Mirror every tool call into the panel and the status bar, so the user can
   * watch the remote client work instead of guessing from the diff alone.
   */
  onToolActivity(event) {
    if (event.phase === "start") {
      this.activities.unshift({
        id: event.id,
        name: event.name,
        summary: event.summary,
        status: "running",
        at: Date.now(),
      });
      if (this.activities.length > 60) this.activities.pop();
      this.activeTool = event.name;
      this.updateStatusBar();
    } else {
      const item = this.activities.find((a) => a.id === event.id);
      if (item) {
        item.status = event.ok ? "ok" : "error";
        item.ms = event.ms;
        item.detail = event.ok ? event.preview : event.error;
        item.meta = event.ok ? metaLabel(event.name, event.meta) : "";
        item.rawMeta = event.ok ? event.meta : undefined;
      }
      this.activeTool = null;
      this.stats.calls += 1;
      this.stats.totalMs += event.ms || 0;
      if (!event.ok) this.stats.failed += 1;
      this.updateStatusBar();
    }
    this.scheduleBroadcast();
  }

  // ------------------------------------------------------------- ui surfaces

  config() {
    return vscode.workspace.getConfiguration("codedock");
  }

  getState() {
    const cfg = this.config();
    const config = {};
    for (const key of CONFIG_KEYS) config[key] = cfg.get(key);
    return {
      running: this.running,
      busy: this.busy,
      endpoint: this.endpoint(),
      guideUrl: this.guideUrl(),
      roots: scope.roots(),
      tunnelProvider: cfg.get("tunnelProvider") || "cloudflared",
      tunnelMessage: this.tunnelMessage,
      config,
      logs: this.logs.slice(-120),
      activities: this.activities.slice(0, 40),
      stats: this.stats,
      metrics: metrics.summary(),
      lastMetric: this.lastMetric,
      concurrency: tools.concurrency(),
      health: this.health,
      todos: ideTools.getTodos(),
      progress: ideTools.getProgress(),
      activeTool: this.activeTool,
      permissions: policy.describe(),
      permissionCounts: policy.counts(),
      allowOutsideWorkspace: this.config().get("allowOutsideWorkspace", false) === true,
      clients: recentClients(),
    };
  }

  scheduleBroadcast() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcast();
    }, 120);
  }

  broadcast() {
    const state = this.getState();
    for (const webview of this.webviews) {
      try {
        webview.postMessage({ type: "state", state });
      } catch {}
    }
  }

  attachWebview(webview) {
    this.webviews.add(webview);
    webview.options = { enableScripts: true };
    const nonce = crypto.randomBytes(16).toString("base64");
    webview.html = renderPanelHtml({ cspSource: webview.cspSource, nonce });
    this.scheduleBroadcast();
  }

  detachWebview(webview) {
    this.webviews.delete(webview);
  }

  renderIdle() {
    this.statusBar.text = "$(circle-slash) CodeDock: 已停止";
    this.statusBar.tooltip = "点击打开控制面板";
    this.statusBar.show();
    this.todosBar.hide();
  }

  renderTodos(todos) {
    if (!todos.length) {
      this.todosBar.hide();
      return;
    }
    const done = todos.filter((t) => t.status === "completed").length;
    const running = todos.find((t) => t.status === "in_progress");
    this.todosBar.text = `$(checklist) ${done}/${todos.length}${running ? ` · ${running.title}` : ""}`;
    this.todosBar.tooltip = ideTools.renderTodos(todos);
    this.todosBar.show();
  }

  updateStatusBar() {
    if (!this.running) {
      this.renderIdle();
      return;
    }
    const progress = ideTools.getProgress();
    if (progress && progress.percent != null) {
      // A reported percentage is the most useful thing the user can glance at.
      this.statusBar.text = `$(sync~spin) ${progress.percent}%${progress.phase ? ` ${progress.phase}` : ""}`;
    } else if (this.activeTool) {
      this.statusBar.text = `$(sync~spin) ${this.activeTool}`;
    } else if (this.busy) {
      this.statusBar.text = "$(sync~spin) CodeDock: 启动中";
    } else {
      this.statusBar.text = "$(radio-tower) CodeDock: 运行中";
    }
    this.statusBar.tooltip = [
      `工作区：${scope.roots().join(", ") || "(未打开文件夹)"}`,
      `连接地址：${this.endpoint() || "(仅本机)"}`,
      progress ? `当前：${progress.phase ? `[${progress.phase}] ` : ""}${progress.message}` : "",
      this.stats.calls ? `工具调用 ${this.stats.calls} 次 · 失败 ${this.stats.failed} 次` : "还没有工具调用",
      "点击打开控制面板",
    ]
      .filter(Boolean)
      .join("\n");
    this.statusBar.show();
  }

  endpoint() {
    const base = this.publicUrl || (this.running && this.port ? `http://127.0.0.1:${this.port}` : null);
    if (!base || !this.routeToken) return null;
    return `${base}/mcp/${this.routeToken}`;
  }

  guideUrl() {
    const base = this.publicUrl || (this.running && this.port ? `http://127.0.0.1:${this.port}` : null);
    if (!base || !this.routeToken) return null;
    return `${base}/guide/${this.routeToken}`;
  }

  // ------------------------------------------------------------------ token

  /**
   * Resolve the token that goes into the URL.
   *
   * Configuration wins over every cached value, and is re-read on each start, so
   * editing `codedock.routeToken` in settings.json takes effect on the next
   * start instead of being shadowed by a token generated in an earlier session.
   */
  async ensureToken() {
    const configured = (this.config().get("routeToken") || "").trim();
    if (configured) {
      // The URL is the credential: a short custom token is a toy lock. Warn,
      // do not block - the user may be running a deliberately isolated setup.
      if (configured.length < 16 && this.routeToken !== configured) {
        this.log(`警告：codedock.routeToken 只有 ${configured.length} 个字符，容易被穷举（建议 ≥16 个随机字符）`);
        vscode.window.showWarningMessage(
          "codedock.routeToken 强度过低：连接地址本身就是钥匙，短令牌可被穷举。建议改用 ≥16 个随机字符，或清空该设置让 CodeDock 自动生成并存入密钥库。"
        );
      }
      if (this.routeToken !== configured) this.log("访问令牌：取自设置 codedock.routeToken");
      this.routeToken = configured;
      return this.routeToken;
    }

    if (this.routeToken) return this.routeToken;

    const stored = await this.context.secrets.get(TOKEN_SECRET_KEY);
    if (stored) {
      this.routeToken = stored;
      this.log("访问令牌：取自密钥库（未设置 codedock.routeToken）");
      return this.routeToken;
    }

    this.routeToken = crypto.randomBytes(16).toString("hex");
    await this.context.secrets.store(TOKEN_SECRET_KEY, this.routeToken);
    this.log("访问令牌：已生成新令牌并存入密钥库");
    return this.routeToken;
  }

  async regenerateToken() {
    const token = crypto.randomBytes(16).toString("hex");
    // Clearing codedock.routeToken fires the configuration listener, whose
    // restart would race the explicit restart below. Suppress it for the
    // duration - this method owns the whole regenerate-and-restart sequence.
    this.suppressConfigRestart = true;
    try {
      await this.context.secrets.store(TOKEN_SECRET_KEY, token);
      await this.config().update("routeToken", "", vscode.ConfigurationTarget.Global);
      this.routeToken = token;
      this.log("访问令牌已重新生成，旧地址立即失效");

      if (this.running) {
        await this.stop();
        await this.start({ silent: true });
      } else {
        this.broadcast();
      }
    } finally {
      this.suppressConfigRestart = false;
    }
    vscode.window.showInformationMessage("访问令牌已更新，请重新复制连接地址。");
  }

  /**
   * Change a permission level.
   *
   * No restart is involved on purpose: the policy is re-read on every tool
   * call, so revoking a level takes effect on the very next one. The log line
   * matters because this is the moment the remote AI gains or loses a power.
   */
  async setPermission(level, enabled) {
    if (!policy.LEVELS.includes(level)) return;
    await this.config().update(`permission.${level}`, enabled === true, vscode.ConfigurationTarget.Global);
    this.log(`权限变更：${policy.LABELS[level]} -> ${enabled ? "开" : "关"}`);
    this.broadcast();
  }

  /** Same live-effect contract as setPermission, for the workspace boundary. */
  async setAllowOutside(enabled) {
    await this.config().update("allowOutsideWorkspace", enabled === true, vscode.ConfigurationTarget.Global);
    this.log(`权限变更：访问工作区外所有路径 -> ${enabled ? "开（整机可访问）" : "关（越界需弹窗确认）"}`);
    this.broadcast();
  }

  // ------------------------------------------------------------------ start

  async start(options = {}) {
    const { silent = false } = options;

    if (this.running) {
      if (!silent) vscode.window.showInformationMessage("CodeDock 已经在运行中。");
      return;
    }

    if (!scope.roots().length) {
      this.tunnelMessage = "没有打开文件夹，无法启动。";
      this.log("start refused: no workspace folder open");
      this.broadcast();
      if (!silent) {
        const pick = await vscode.window.showWarningMessage(
          "当前窗口没有打开文件夹，CodeDock 无法确定操作范围 —— 没有范围就没有授权。",
          "打开文件夹"
        );
        if (pick === "打开文件夹") await vscode.commands.executeCommand("vscode.openFolder");
      }
      return;
    }

    // Licence gate. With no codedock.licensePublicKey configured this is a no-op
    // (isActive returns true), so personal use is unaffected; a distribution
    // that sets a public key refuses to start on a missing or invalid CDK.
    if (!(await license.isActive())) {
      this.tunnelMessage = "许可证无效，服务未启动。";
      this.log("start refused: licence check failed");
      this.broadcast();
      if (!silent) {
        vscode.window.showErrorMessage("CodeDock 许可证无效或缺失，请输入有效 CDK 后重试。");
      }
      return;
    }

    this.busy = true;
    this.tunnelMessage = "";
    this.updateStatusBar();
    this.broadcast();

    try {
      const cfg = this.config();
      this.port = Number(cfg.get("port")) || 8787;
      await this.ensureToken();

      const dispatcher = createDispatcher({
        roots: scope.roots,
        extraInstructions: () => this.config().get("extraInstructions") || "",
        log: (msg) => this.log(msg),
      });

      this.server = createHttpServer({
        dispatcher,
        routeToken: this.routeToken,
        getPublicUrl: () => this.publicUrl,
        roots: scope.roots,
        log: (msg) => this.log(msg),
        onMetric: (rec) => this.onMetric(rec),
      });

      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.port, "127.0.0.1", () => resolve());
      });

      const provider = cfg.get("tunnelProvider") || "cloudflared";
      await this.ensureTunnel(provider, cfg, silent);

      this.running = true;
      this.log(`服务已监听 127.0.0.1:${this.port}，范围=${scope.roots().join(" | ")}`);
      if (this.publicUrl) this.log(`连接地址：${this.endpoint()}`);
      this.probeHealth().catch(() => {});
      this.scheduleHealthProbe();
    } catch (err) {
      this.log(`启动失败：${err.message}`);
      this.tunnelMessage = `启动失败：${err.message}`;
      this.running = false;
      if (this.server) {
        try { this.server.close(); } catch {}
        this.server = null;
      }
      if (this.tunnel) {
        this.tunnel.stop();
        this.tunnel = null;
      }
      if (!silent) vscode.window.showErrorMessage(`CodeDock 启动失败：${err.message}`);
    } finally {
      this.busy = false;
      this.updateStatusBar();
      this.broadcast();
    }

    if (this.running && this.publicUrl && !silent) {
      // Only an explicit start touches the clipboard - an automatic/reload
      // start must not overwrite whatever the user just copied.
      await vscode.env.clipboard.writeText(this.endpoint());
      const action = await vscode.window.showInformationMessage("CodeDock 已启动，连接地址已复制到剪贴板。", "打开向导页", "控制面板");
      if (action === "打开向导页") await this.openGuide();
      else if (action === "控制面板") await this.openPanel();
    }
  }

  /**
   * Bring up the tunnel, reusing a live one when it still matches.
   *
   * Reuse matters most for quick tunnels: rebuilding one hands out a brand new
   * hostname, so a settings tweak would otherwise silently invalidate the
   * address the user already pasted into their client.
   */
  async ensureTunnel(provider, cfg, silent) {
    const reusable =
      this.tunnel &&
      this.tunnel.isRunning() &&
      this.tunnel.provider === provider &&
      this.tunnel.port === this.port;

    if (reusable) {
      this.publicUrl = this.tunnel.url;
      this.tunnelMessage = "";
      this.log(`复用现有隧道：${this.publicUrl}`);
      return;
    }

    if (this.tunnel) {
      this.tunnel.stop();
      this.tunnel = null;
    }
    this.publicUrl = null;

    this.tunnel = new TunnelManager({
      provider,
      port: this.port,
      configuredPath:
        provider === "ngrok"
          ? cfg.get("ngrokPath")
          : provider === "openai"
          ? cfg.get("openaiTunnelClientPath")
          : cfg.get("cloudflaredPath"),
      ngrokConfigPath: cfg.get("ngrokConfigPath"),
      ngrokAuthtoken: cfg.get("ngrokAuthtoken"),
      ngrokDomain: cfg.get("ngrokDomain"),
      cloudflareTunnelToken: cfg.get("cloudflareTunnelToken"),
      cloudflareHostname: cfg.get("cloudflareHostname"),
      openaiTunnelId: cfg.get("openaiTunnelId"),
      openaiApiKey: cfg.get("openaiApiKey"),
      openaiTunnelClientPath: cfg.get("openaiTunnelClientPath"),
      searchDirs: scope.roots(),
      log: (msg) => this.log(msg),
      onExit: (code) => {
        this.log(`隧道进程退出（code ${code}），准备自动重连`);
        this.tunnelMessage = "隧道已断开，正在自动重连…";
        this.updateStatusBar();
        this.broadcast();
      },
      onUrlChanged: (url) => {
        const changed = url !== this.publicUrl;
        this.publicUrl = url;
        this.tunnelMessage = "";
        this.log(`隧道已重连：${url}`);
        this.updateStatusBar();
        this.broadcast();
        if (changed) {
          vscode.window.showInformationMessage(`隧道已自动重连，地址变了：${url}`);
        }
      },
      onGaveUp: () => {
        this.publicUrl = null;
        this.tunnelMessage = "隧道自动重连失败，请手动重启服务。";
        this.updateStatusBar();
        this.broadcast();
        vscode.window.showWarningMessage("隧道自动重连失败，请手动重启 Bridge。");
      },
    });

    try {
      this.publicUrl = await this.tunnel.start();
      if (!this.publicUrl) {
        this.tunnelMessage = "隧道已关闭（tunnelProvider = none），仅本机 127.0.0.1 可访问。";
      }
    } catch (err) {
      this.log(`隧道建立失败：${err.message}`);
      this.publicUrl = null;
      this.tunnelMessage = `隧道未建立：${err.message}`;
      if (!silent) vscode.window.showWarningMessage(`隧道未建立：${err.message}`);
    }
  }

  async stop(options = {}) {
    const keepTunnel = Boolean(options.keepTunnel);

    this.busy = true;
    this.updateStatusBar();
    this.broadcast();

    if (this.tunnel && !keepTunnel) {
      this.tunnel.stop();
      this.tunnel = null;
    }
    if (!keepTunnel) this.publicUrl = null;

    if (this.server) {
      const server = this.server;
      this.server = null;
      // close() alone waits for open SSE/event streams, which never end on
      // their own - force-destroy the connections so stop() cannot hang.
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.destroyConnections === "function") server.destroyConnections();
        else if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      });
    }

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.health = null;

    execTools.disposeAll();
    gateway.disposeAll();
    ideTools.clearProgress();
    this.running = false;
    this.busy = false;
    this.activeTool = null;
    this.todosBar.hide();
    this.log("服务已停止");
    this.renderIdle();
    this.broadcast();
  }

  // ------------------------------------------------------------- ui actions

  async copyUrl() {
    const endpoint = this.endpoint();
    if (!endpoint) {
      vscode.window.showWarningMessage("CodeDock 未运行，没有可复制的地址。");
      return;
    }
    await vscode.env.clipboard.writeText(endpoint);
    vscode.window.showInformationMessage("连接地址已复制。");
  }

  /** The one-liner to paste into a web agent that speaks MCP from its chat box. */
  async copyPrompt() {
    const endpoint = this.endpoint();
    if (!endpoint) {
      vscode.window.showWarningMessage("CodeDock 未运行，没有可复制的接入语句。");
      return;
    }
    const guide = this.guideUrl();
    const text = buildConnectionPrompt({
      endpoint,
      guideTextUrl: guide ? `${guide}?format=text` : null,
    });
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage("接入语句已复制，直接粘给网页端 AI 即可。");
  }

  async openGuide() {
    const url = this.guideUrl();
    if (!url) {
      vscode.window.showWarningMessage("CodeDock 未运行，没有向导页。");
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Probe both ends of the bridge.
   *
   * The local probe proves the HTTP server is answering; the public probe goes
   * out through the tunnel and back, which is the only way to know the address
   * the user pasted into a client is actually reachable right now.
   */
  async probeHealth() {
    if (!this.running) return;

    const probe = async (url) => {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          headers: { "ngrok-skip-browser-warning": "1" },
          signal: AbortSignal.timeout(6000),
        });
        return { ok: res.ok, latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    };

    const local = await probe(`http://127.0.0.1:${this.port}/healthz`);
    const publicProbe = this.publicUrl ? await probe(`${this.publicUrl}/healthz`) : null;
    this.health = {
      at: Date.now(),
      local,
      public: publicProbe,
      tunnelAlive: Boolean(this.tunnel && this.tunnel.isRunning()),
    };
    this.broadcast();
  }

  scheduleHealthProbe() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      this.probeHealth().catch(() => {});
    }, 90000);
    this.healthTimer.unref?.();
  }

  /**
   * Open a side-by-side diff for an edit the agent already made.
   *
   * The file on disk has moved on by now, so the left side comes from the
   * snapshot taken at edit time rather than from anything still on disk.
   */
  async openActivityDiff(id) {
    const item = this.activities.find((entry) => entry.id === id);
    const meta = item && item.rawMeta;
    if (!meta || !meta.beforePath || !meta.file) {
      vscode.window.showInformationMessage("这条记录没有可对比的改动快照。");
      return;
    }
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(meta.beforePath),
        scope.toUri(meta.file),
        `${meta.file} · AI 修改前 ↔ 现在`
      );
    } catch (err) {
      vscode.window.showWarningMessage(`无法打开 diff：${err.message}`);
    }
  }

  /** Command-palette entry: prefer the activity-bar view, else an editor tab. */
  async openPanel() {
    try {
      await vscode.commands.executeCommand("codedock.panel.focus");
      return;
    } catch {}
    await this.openPanelIn(vscode.ViewColumn.Active);
  }

  /** Open the panel in a split to the side, for a second-screen layout. */
  async openPanelBeside() {
    await this.openPanelIn(vscode.ViewColumn.Beside);
  }

  async openPanelIn(column) {
    if (this.editorPanel) {
      this.editorPanel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "codedock.panelEditor",
      "CodeDock 控制面板",
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.editorPanel = panel;
    this.attachWebview(panel.webview);
    panel.onDidDispose(() => {
      this.detachWebview(panel.webview);
      this.editorPanel = null;
    });
  }

  async saveConfig(values) {
    const cfg = this.config();
    const target = vscode.ConfigurationTarget.Global;
    for (const key of CONFIG_KEYS) {
      if (!(key in values)) continue;
      await cfg.update(key, values[key], target);
    }
    this.log("参数已保存");
    this.broadcast();
    // Restarting (when needed) is handled centrally by the configuration
    // listener, so a change made here and one made in settings.json behave
    // exactly the same way.
  }

  async onWebviewMessage(message) {
    switch (message.type) {
      case "ready":
      case "refresh":
        this.broadcast();
        break;
      case "start":
        await this.start({ silent: true });
        break;
      case "stop":
        await this.stop();
        break;
      case "copy":
        await this.copyUrl();
        break;
      case "copyPrompt":
        await this.copyPrompt();
        break;
      case "openDiff":
        await this.openActivityDiff(Number(message.id));
        break;
      case "guide":
        await this.openGuide();
        break;
      case "save":
        await this.saveConfig(message.values || {});
        break;
      case "regenerateToken":
        await this.regenerateToken();
        break;
      case "setPermission":
        await this.setPermission(message.level, message.enabled);
        break;
      case "setAllowOutside":
        await this.setAllowOutside(message.enabled);
        break;
      default:
        break;
    }
  }

  dispose() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.tunnel) this.tunnel.stop();
    if (this.server) {
      try {
        if (typeof this.server.destroyConnections === "function") this.server.destroyConnections();
        this.server.close();
      } catch {}
    }
    execTools.disposeAll();
    this.statusBar.dispose();
    this.todosBar.dispose();
    this.output.dispose();
  }
}

class PanelViewProvider {
  constructor(controller) {
    this.controller = controller;
  }

  resolveWebviewView(view) {
    this.controller.attachWebview(view.webview);
    view.webview.onDidReceiveMessage((message) => this.controller.onWebviewMessage(message));
    view.onDidDispose(() => this.controller.detachWebview(view.webview));
  }
}

/** Start when the window has a folder and the user has opted into auto start. */
async function maybeAutoStart(controller, reason) {
  // Default is off: installing the extension must not open a public tunnel by
  // itself. A missing/legacy value stays off too (only an explicit true starts).
  const autoStart = controller.config().get("autoStart") === true;
  if (!autoStart) return;
  if (controller.running || controller.busy) return;
  if (!scope.roots().length) return;
  controller.log(`自动启动（${reason}）`);
  await controller.start({ silent: true });
}

function activate(context) {
  // Licence storage lives in the secret store; wire it before anything can start.
  license.init(context);
  const controller = new BridgeController(context);
  context.subscriptions.push(controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codedock.panel", new PanelViewProvider(controller), {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codedock.openPanel", () => controller.openPanel()),
    vscode.commands.registerCommand("codedock.openPanelBeside", () => controller.openPanelBeside()),
    vscode.commands.registerCommand("codedock.start", () => controller.start()),
    vscode.commands.registerCommand("codedock.stop", () => controller.stop()),
    vscode.commands.registerCommand("codedock.copyUrl", () => controller.copyUrl()),
    vscode.commands.registerCommand("codedock.openGuide", () => controller.openGuide())
  );

  // Settings changed anywhere - our panel or settings.json - take effect the
  // same way: restart the bridge when the change needs a restart to apply.
  const RESTART_KEYS = [...TUNNEL_KEYS, "routeToken"];
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("codedock")) return;
      controller.broadcast();

      // regenerateToken() drives its own restart; reacting here too would
      // stop/start the bridge twice concurrently.
      if (controller.suppressConfigRestart) return;

      const needsRestart = RESTART_KEYS.some((key) => event.affectsConfiguration(`codedock.${key}`));
      if (!needsRestart || !controller.running) return;

      const tunnelChanged = TUNNEL_KEYS.some((key) => event.affectsConfiguration(`codedock.${key}`));
      controller.log(tunnelChanged ? "隧道配置已变更，重建隧道" : "配置已变更，复用现有隧道并重启服务");
      await controller.stop({ keepTunnel: !tunnelChanged });
      await controller.start({ silent: true });
    })
  );

  // Scope follows the window: instructions and tools read workspaceFolders live,
  // and opening a folder is what makes auto start meaningful.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      controller.log(`工作区变化：${scope.roots().join(" | ") || "(无)"}`);
      controller.updateStatusBar();
      controller.broadcast();
      maybeAutoStart(controller, "工作区已打开").catch((err) => controller.log(`自动启动失败：${err.message}`));
    })
  );

  maybeAutoStart(controller, "扩展已激活").catch((err) => controller.log(`自动启动失败：${err.message}`));
}

/**
 * Cleanup that matters for an uninstall.
 *
 * The pre-edit snapshots live in the system temp folder - outside both the
 * workspace and the extension - so without this they would outlive the
 * extension that created them. Everything else (bin/, the bundled tunnel
 * binaries, cached state) disappears with the extension folder itself.
 */
function deactivate() {
  try {
    gateway.disposeAll();
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    fs.rmSync(path.join(os.tmpdir(), "codedock-before"), { recursive: true, force: true });
  } catch {}
}

module.exports = { activate, deactivate };

