/**
 * Tunnel management.
 *
 * The extension owns the tunnel so the user only has to open the editor - the
 * same experience as any editor-native bridge. cloudflared is preferred because
 * a quick tunnel needs no account; ngrok is supported for people who already
 * have a config file with a stable domain.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Reconnect schedule after a dropped tunnel. Long enough not to hammer a flaky
 * network, short enough that a brief blip is invisible to the user.
 */
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

const CLOUDFLARE_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
/** Matches real tunnel hosts only, so dashboard/API links in the agent log are ignored. */
const NGROK_PATTERN = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|dev|io)/i;

/** Accept `mcp.example.com`, `https://mcp.example.com/` - store one shape. */
function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/** Bundled/sought binary name for the current platform. */
function tunnelBinary(provider) {
  const win = process.platform === "win32";
  if (provider === "ngrok") return win ? "ngrok.exe" : "ngrok";
  if (provider === "openai") return win ? "tunnel-client.exe" : "tunnel-client";
  return win ? "cloudflared.exe" : "cloudflared";
}

function findExecutable(name, configured, searchDirs) {
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    throw new Error(`配置的路径不存在：${configured}`);
  }

  const candidates = [];
  // The packaged extension ships its own tunnel binaries, so a fresh install
  // works without downloading or installing anything.
  candidates.push(path.join(__dirname, "..", "bin", name));

  const home = os.homedir();
  candidates.push(path.join(home, "Desktop", "devin-mcp-bridge", name));
  candidates.push(path.join(home, "devin-mcp-bridge", name));
  // Deliberately NOT searched: ~/Downloads and the workspace folders. Both are
  // directories someone else can plant a file in (a cloned repository can ship
  // a binary named cloudflared.exe), and a tunnel binary is code execution
  // that runs the moment the bridge starts. Use the explicit path settings
  // (codedock.cloudflaredPath / ngrokPath) for a binary kept elsewhere.
  void searchDirs;

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

class TunnelManager {
  constructor({
    provider,
    port,
    configuredPath,
    ngrokConfigPath,
    ngrokAuthtoken,
    ngrokDomain,
    cloudflareTunnelToken,
    cloudflareHostname,
    openaiTunnelId,
    openaiApiKey,
    openaiTunnelClientPath,
    searchDirs,
    log,
    onExit,
    onUrlChanged,
    onGaveUp,
    autoRestart,
  }) {
    this.provider = provider || "cloudflared";
    this.port = port;
    this.configuredPath = configuredPath;
    this.ngrokConfigPath = ngrokConfigPath;
    this.ngrokAuthtoken = (ngrokAuthtoken || "").trim();
    this.ngrokDomain = (ngrokDomain || "").trim();
    this.cloudflareTunnelToken = (cloudflareTunnelToken || "").trim();
    this.cloudflareHostname = normalizeHostname(cloudflareHostname);
    this.openaiTunnelId = (openaiTunnelId || "").trim();
    this.openaiApiKey = (openaiApiKey || "").trim();
    this.openaiTunnelClientPath = (openaiTunnelClientPath || "").trim();
    this.searchDirs = searchDirs || [];
    this.log = log || (() => {});
    this.onExit = onExit || (() => {});
    this.onUrlChanged = onUrlChanged || (() => {});
    this.onGaveUp = onGaveUp || (() => {});
    this.autoRestart = autoRestart !== false;
    this.child = null;
    this.url = null;
    this.stopping = false;
    this.restartAttempt = 0;
    this.restartTimer = null;
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** First start. Reconnects after this are driven by the exit handler. */
  async start() {
    if (this.provider === "none") {
      this.log("tunnel disabled by configuration; serving on 127.0.0.1 only");
      return null;
    }
    if (this.isRunning()) return this.url;

    this.stopping = false;
    const url = await this.launch();
    this.restartAttempt = 0;
    return url;
  }

  /**
   * Named tunnel.
   *
   * Unlike a quick tunnel the hostname is fixed - the user picks it in the
   * Cloudflare dashboard - so there is nothing to scrape out of the logs. The
   * only thing worth waiting for is proof that the edge accepted the token.
   */
  async launchNamed() {
    const hostname = this.cloudflareHostname;
    if (!this.cloudflareTunnelToken) {
      throw new Error(
        "具名隧道缺少 token。请在 Cloudflare Zero Trust → Networks → Tunnels 创建隧道，把令牌填到设置 codedock.cloudflareTunnelToken。"
      );
    }
    if (!hostname) {
      throw new Error(
        "具名隧道缺少固定域名。请把隧道的 Public Hostname 填到设置 codedock.cloudflareHostname，例如 mcp.example.com。"
      );
    }

    const exePath = findExecutable(tunnelBinary("cloudflared"), this.configuredPath, this.searchDirs);
    if (!exePath) {
      throw new Error("找不到 cloudflared.exe。请把它的完整路径填到设置 codedock.cloudflaredPath。");
    }

    this.log(`starting cloudflare named tunnel -> ${hostname}`);

    const child = spawn(exePath, ["tunnel", "--no-autoupdate", "run", "--token", this.cloudflareTunnelToken], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.url = null;

    const publicUrl = `https://${hostname}`;

    const url = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(
        () => done(reject, new Error("cloudflared 具名隧道 30 秒内没有连接成功，请检查 token 是否有效。")),
        30000
      );

      const scan = (chunk) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (/Registered tunnel connection|Connection.*registered/i.test(trimmed)) {
            done(resolve, publicUrl);
            return;
          }
          if (/error|failed|invalid|unauthorized|forbidden/i.test(trimmed)) {
            this.log(`[cloudflared] ${trimmed.slice(0, 200)}`);
          }
        }
      };

      child.stdout.on("data", scan);
      child.stderr.on("data", scan);
      child.on("error", (err) => done(reject, err));
      child.on("exit", (code) => {
        this.child = null;
        this.url = null;
        if (!settled) {
          done(reject, new Error(`cloudflared 退出（code ${code}）：token 无效或隧道未配置`));
          return;
        }
        this.onExit(code);
        if (this.autoRestart && !this.stopping) this.scheduleRestart();
      });
    });

    this.url = url;
    this.log(`tunnel ready: ${url}`);
    return url;
  }

  async launchOpenAI() {
    if (!this.openaiTunnelId) {
      throw new Error("OpenAI Secure Tunnel 缺少 tunnel_id。请在设置 codedock.openaiTunnelId 填入 Tunnel ID。");
    }
    const exeName = tunnelBinary("openai");
    const exePath = findExecutable(exeName, this.openaiTunnelClientPath, this.searchDirs);
    if (!exePath) {
      throw new Error("找不到 tunnel-client.exe。请安装 OpenAI tunnel-client 或设置 codedock.openaiTunnelClientPath。");
    }

    this.log(`starting openai secure tunnel: id=${this.openaiTunnelId}`);
    const args = ["--tunnel-id", this.openaiTunnelId, "--port", String(this.port)];
    const env = { ...process.env };
    if (this.openaiApiKey) {
      env.CONTROL_PLANE_API_KEY = this.openaiApiKey;
      env.OPENAI_API_KEY = this.openaiApiKey;
    }

    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    this.child = child;

    const publicUrl = `https://${this.openaiTunnelId}.openai-mcp.internal`;

    const url = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => done(resolve, publicUrl), 3000);

      const scan = (chunk) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.log(`[openai-tunnel] ${trimmed.slice(0, 200)}`);
          if (/connected|ready|listening/i.test(trimmed)) {
            done(resolve, publicUrl);
            return;
          }
        }
      };

      child.stdout.on("data", scan);
      child.stderr.on("data", scan);
      child.on("error", (err) => done(reject, err));
      child.on("exit", (code) => {
        this.child = null;
        this.url = null;
        if (!settled) {
          done(reject, new Error(`tunnel-client 退出（code ${code}）`));
          return;
        }
        this.onExit(code);
        if (this.autoRestart && !this.stopping) this.scheduleRestart();
      });
    });

    this.url = url;
    this.log(`openai tunnel ready: ${url}`);
    return url;
  }

  /** Spawn the tunnel agent and wait for it to report a public URL. */
  async launch() {
    if (this.provider === "cloudflare-named") return await this.launchNamed();
    if (this.provider === "openai") return await this.launchOpenAI();

    const exeName = tunnelBinary(this.provider === "ngrok" ? "ngrok" : "cloudflared");
    const exePath = findExecutable(exeName, this.configuredPath, this.searchDirs);
    if (!exePath) {
      throw new Error(
        `找不到 ${exeName}。请把它的完整路径填到设置 codedock.${this.provider === "ngrok" ? "ngrokPath" : "cloudflaredPath"}，` +
          `或把 ${exeName} 放到 devin-mcp-bridge 目录下。也可以把 codedock.tunnelProvider 改成 none，只用本机访问。`
      );
    }

    const args =
      this.provider === "ngrok"
        ? [
            "http",
            String(this.port),
            "--log",
            "stdout",
            ...(this.ngrokConfigPath && fs.existsSync(this.ngrokConfigPath)
              ? ["--config", this.ngrokConfigPath]
              : []),
            ...(this.ngrokAuthtoken ? ["--authtoken", this.ngrokAuthtoken] : []),
            ...(this.ngrokDomain ? ["--domain", this.ngrokDomain] : []),
          ]
        : [
            "tunnel",
            "--url",
            `http://127.0.0.1:${this.port}`,
            "--edge-ip-version",
            "4",
            "--protocol",
            "http2",
            "--no-autoupdate",
          ];

    this.log(`starting ${this.provider}: ${exePath}`);

    const child = spawn(exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.url = null;

    const pattern = this.provider === "ngrok" ? NGROK_PATTERN : CLOUDFLARE_PATTERN;

    const url = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`${this.provider} 在 45 秒内没有返回公网地址，请检查网络或改用云隧道 none / ngrok。`));
        }
      }, 45000);

      const scan = (chunk) => {
        const text = chunk.toString("utf8");
        const found = pattern.exec(text);
        if (found && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(found[0]);
          return;
        }
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed && /error|failed|ERR_/i.test(trimmed)) this.log(`[${this.provider}] ${trimmed.slice(0, 220)}`);
        }
      };

      child.stdout.on("data", scan);
      child.stderr.on("data", scan);

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      child.on("exit", (code) => {
        this.child = null;
        this.url = null;

        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${this.provider} 进程提前退出（code ${code}）`));
          return;
        }

        this.onExit(code);
        if (this.autoRestart && !this.stopping) this.scheduleRestart();
      });
    });

    this.url = url;
    this.log(`tunnel ready: ${url}`);
    return url;
  }

  /**
   * Reconnect with backoff.
   *
   * A dropped tunnel used to leave the user with a dead URL until they noticed
   * and restarted by hand. Now a blip recovers on its own, and a changed domain
   * (cloudflared quick tunnels hand out a new one every launch) is pushed to the
   * UI immediately instead of silently going stale.
   */
  scheduleRestart() {
    if (this.restartTimer || this.stopping) return;

    const attempt = this.restartAttempt++;
    if (attempt >= RESTART_BACKOFF_MS.length) {
      this.log(`隧道连续 ${RESTART_BACKOFF_MS.length} 次重连失败，放弃自动重连`);
      this.onGaveUp();
      return;
    }

    const delay = RESTART_BACKOFF_MS[attempt];
    this.log(`隧道断开，${Math.round(delay / 1000)} 秒后重连（第 ${attempt + 1}/${RESTART_BACKOFF_MS.length} 次）`);

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.stopping) return;
      try {
        const url = await this.launch();
        this.restartAttempt = 0;
        this.log(`隧道已重连：${url}`);
        this.onUrlChanged(url);
      } catch (err) {
        this.log(`重连失败：${err.message}`);
        this.scheduleRestart();
      }
    }, delay);
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartAttempt = 0;

    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.url = null;
    if (/^win/i.test(process.platform)) {
      try {
        require("child_process").execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      } catch {}
    } else {
      try { child.kill("SIGTERM"); } catch {}
    }
  }
}

module.exports = {
  TunnelManager,
  findExecutable,
  tunnelBinary,
  normalizeHostname,
  CLOUDFLARE_PATTERN,
  NGROK_PATTERN,
  RESTART_BACKOFF_MS,
};

