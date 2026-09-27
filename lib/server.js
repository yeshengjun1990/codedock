/**
 * Local HTTP surface.
 *
 * Zero dependencies on purpose: the extension host already provides Node, and a
 * handful of routes does not justify pulling express into a .vsix.
 *
 * Routes:
 *   GET    /healthz          readiness probe, no token
 *   POST   /mcp/<token>      JSON-RPC (Streamable HTTP)
 *   GET    /mcp/<token>      server-initiated stream, kept alive with heartbeats
 *   DELETE /mcp/<token>      session teardown, a no-op when stateless
 *   GET    /guide/<token>    copy-paste onboarding page
 *   GET    /sse              SSE transport, for clients that only speak it
 *   POST   /message          the POST half of that transport
 *
 * Two transports, one protocol layer: SSE and Streamable HTTP both funnel into
 * the same dispatcher, so a tool call behaves identically whichever one carried
 * it. SSE is kept for older clients; new ones should use /mcp/<token>.
 */

const http = require("http");
const crypto = require("crypto");
const toolsRegistry = require("./tools");
const { buildConnectionPrompt } = require("./prompt");
const metrics = require("./metrics");
const SERVER_VERSION = require("../package.json").version;

const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Open event-stream connections per type; each one holds a heartbeat timer. */
const MAX_SSE_STREAMS = 32;

/**
 * No CORS headers on purpose.
 *
 * The intended clients are server-side agents (ChatGPT/Claude/Grok connectors,
 * Devin, curl) - none of them need CORS. Wildcard CORS here would let any page
 * in the user's browser read responses from the local server, and an open
 * browser tab is exactly the attacker we do not want to hand the workspace to.
 * With no CORS headers, cross-origin JSON POSTs die at preflight and cross-origin
 * reads are invisible.
 */
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * POST bodies must declare application/json.
 *
 * JSON-RPC bodies posted as text/plain would slip past browser preflight as a
 * "simple request", so a drive-by page could blind-fire tool calls at the
 * endpoint even without reading responses. The MCP spec and every documented
 * client send application/json; anything else is rejected before parsing.
 */
function isJsonRequest(req) {
  return String(req.headers["content-type"] || "").toLowerCase().includes("application/json");
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      if (!raw.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Run a batch of JSON-RPC messages through the dispatcher.
 *
 * Shared by both transports, so a request is handled identically no matter which
 * one carried it. Notifications are logged and skipped, which is what the spec
 * asks for when there is nothing to answer.
 */
async function processJsonRpc(dispatcher, body, log) {
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const isNotification = message.id === undefined && typeof message.method === "string";
    if (isNotification) {
      log(`notification: ${message.method}`);
      continue;
    }
    if (message.id === undefined) continue;

    try {
      const result = await dispatcher.handle(message);
      responses.push({ jsonrpc: "2.0", id: message.id, result });
    } catch (err) {
      log(`error on ${message.method}: ${err.message}`);
      responses.push(rpcError(message.id, err.code || -32603, err.message));
    }
  }

  return responses;
}

/** Escape text interpolated into the guide page (paths and prompts are data, not markup). */
function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function guideHtml({ endpoint, prompt, roots, guideTextUrl, sseUrl }) {
  const scopeText = escapeHtml(roots.length ? roots.join("\n") : "(no folder open)");
  const allInOne = escapeHtml(buildConnectionPrompt({ endpoint, guideTextUrl }));
  const safeEndpoint = escapeHtml(endpoint);
  const safeSseUrl = escapeHtml(sseUrl);
  const safePrompt = escapeHtml(prompt);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeDock 接入向导</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:32px 20px; background:#0d1117; color:#e6edf3;
         font-family:"Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif; }
  .wrap { max-width:780px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.sub { color:#8b949e; margin:0 0 26px; font-size:13px; }
  h2 { font-size:15px; margin:26px 0 10px; color:#58a6ff; }
  .row { display:flex; gap:8px; }
  input { flex:1; padding:11px 13px; background:#161b22; border:1px solid #30363d;
          border-radius:6px; color:#e6edf3; font-family:Consolas,monospace; font-size:13px; }
  textarea { width:100%; box-sizing:border-box; min-height:110px; padding:11px 13px; background:#161b22;
             border:1px solid #30363d; border-radius:6px; color:#e6edf3;
             font-family:Consolas,monospace; font-size:12.5px; line-height:1.55; resize:vertical; }
  button { padding:11px 18px; background:#238636; border:0; border-radius:6px;
           color:#fff; font-size:13px; cursor:pointer; white-space:nowrap; }
  button:hover { background:#2ea043; }
  ol { color:#c9d1d9; line-height:1.85; font-size:13.5px; padding-left:22px; }
  pre { background:#161b22; border:1px solid #30363d; border-radius:6px; padding:10px 12px;
        font-size:12.5px; overflow:auto; color:#8b949e; }
  .warn { margin-top:28px; padding:12px 14px; background:#2d1b1b; border-left:3px solid #f85149;
          border-radius:0 6px 6px 0; color:#f0c2c2; font-size:12.5px; line-height:1.7; }
  .ok { color:#3fb950; font-size:12px; margin-left:8px; opacity:0; transition:opacity .2s; }
  .hint { color:#8b949e; font-size:12px; line-height:1.6; }
</style></head><body><div class="wrap">
<h1>MCP 桥接 · 接入向导</h1>
<p class="sub">当前编辑器窗口打开的工作区：</p>
<pre>${scopeText}</pre>

<h2>1. 一句话接入（平台支持在对话里加 MCP 时，粘这一段）</h2>
<textarea id="all" readonly>${allInOne}</textarea>
<button style="margin-top:8px" onclick="cp('all','ok0')">复制接入语句</button><span id="ok0" class="ok">已复制</span>
<div class="hint" style="margin-top:8px">
  适用于支持「粘贴即接入 MCP」的 Agent 平台 / 镜像站。大厂网页版（ChatGPT / Claude / Grok）必须先按第 2 步配一次连接器。
</div>

<h2>2. MCP 连接地址（配置连接器时用这段）</h2>
<div class="row">
  <input id="ep" readonly value="${safeEndpoint}">
  <button onclick="cp('ep','ok1')">复制</button>
</div><span id="ok1" class="ok">已复制</span>
<div class="hint" style="margin-top:8px">
  只认 SSE 的老客户端（例如 Devin）用这条，传输方式选 <b>SSE</b>。令牌已经写在地址里，不需要再填任何鉴权头：<br>
  <code>${safeSseUrl}</code>
</div>

<h2>3. 提示词（可选，粘贴到对话里让 AI 立即上手）</h2>
<textarea id="pr" readonly>${safePrompt}</textarea>
<button style="margin-top:8px" onclick="cp('pr','ok2')">复制提示词</button><span id="ok2" class="ok">已复制</span>

<h2>4. 接入步骤</h2>
<ol>
  <li>打开网页版 AI（ChatGPT / Claude / Grok 等）→ <b>设置 → 连接器 / Connectors</b></li>
  <li>选择 <b>添加自定义连接器</b>，名称随意，地址粘贴上面的连接地址</li>
  <li>身份验证选 <b>无身份验证（No authentication）</b>，不要选 OAuth</li>
  <li>保存后新开一个对话，把第 3 步的提示词粘贴发送</li>
</ol>

<div class="warn">
  这个地址等同于该工作区的钥匙：任何拿到它的人都能读写上述目录。<br>
  不要截图外发、不要贴进公开对话。地址泄露就重启 CodeDock 换一个。
</div>

<script>
function cp(id, okId) {
  const el = document.getElementById(id);
  el.select();
  navigator.clipboard.writeText(el.value).catch(() => document.execCommand("copy"));
  const ok = document.getElementById(okId);
  ok.style.opacity = 1;
  setTimeout(() => { ok.style.opacity = 0; }, 1400);
}
</script>
</div></body></html>`;
}

/**
 * Plain-text briefing for agents that speak to the endpoint with curl instead of
 * a native MCP connector. Everything needed to handshake, with the exact
 * commands, so the agent does not have to infer the protocol.
 */
async function guideText({ endpoint, roots, sseUrl }) {
  const root = roots[0] || "(no folder open)";
  const hint = `-H "Content-Type: application/json" -H "ngrok-skip-browser-warning: 1"`;
  const names = await toolsRegistry.toolNames();
  return `MCP bridge to a live code editor window on the user's machine.

Endpoint : ${endpoint}
Transport: Streamable HTTP, stateless. Every POST is answered on its own; no
           session id, no SSE stream required. Responses are plain JSON.
Header   : ${hint}
           (ngrok-skip-browser-warning avoids ngrok's browser interstitial.)

If your client only speaks SSE, use this URL instead (transport "sse"; the token
is already in it, so no auth header is needed):
  ${sseUrl || "(not available)"}

Reachable scope (the only files you can touch): ${root}

1) Handshake
curl -sS -X POST "${endpoint}" ${hint} \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"web-agent","version":"1"}}}'

2) List tools
curl -sS -X POST "${endpoint}" ${hint} \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

3) Call a tool
curl -sS -X POST "${endpoint}" ${hint} \\
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_files","arguments":{"paths":["README.md"]}}}'

Available tools: ${names.join(", ")}

Working rules:
- Read a file before editing it; apply_patch replaces exact text and must match
  exactly once, so include enough surrounding context.
- Run get_diagnostics after edits to confirm the change still compiles.
- For long commands use run_command with wait=false, then poll
  get_command_output; stop it with cancel_command.
- Every path must stay inside the scope above; anything else is rejected.
`;
}

function createHttpServer({ dispatcher, routeToken, getPublicUrl, roots, log, onMetric }) {
  /** Open SSE streams: sessionId -> { res, heartbeat }. */
  const sseSessions = new Map();

  const baseUrl = () => getPublicUrl() || `http://127.0.0.1:${server.address() ? server.address().port : 0}`;

  /**
   * Open an SSE stream and tell the client where to POST.
   *
   * The endpoint event is the whole point of this transport: an SSE client has
   * no way to guess the message URL, so the server has to hand it over. The
   * token rides along in that URL, which means the client needs no extra
   * configuration - the same "URL is the credential" rule as the HTTP transport.
   */
  function openSseStream(req, res) {
    if (sseSessions.size >= MAX_SSE_STREAMS) {
      sendJson(
        res,
        503,
        rpcError(null, -32000, `too many open SSE streams (limit ${MAX_SSE_STREAMS}); close one and retry`)
      );
      return;
    }

    const sessionId = crypto.randomBytes(16).toString("hex");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const endpoint = `${baseUrl()}/message?sessionId=${sessionId}&token=${encodeURIComponent(routeToken)}`;
    res.write(`event: endpoint\ndata: ${endpoint}\n\n`);

    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch {}
    }, 15000);

    sseSessions.set(sessionId, { res, heartbeat });
    log(`sse stream opened ${sessionId.slice(0, 8)} (${sseSessions.size} active)`);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (sseSessions.delete(sessionId)) {
        log(`sse stream closed ${sessionId.slice(0, 8)} (${sseSessions.size} active)`);
      }
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  /**
   * The POST half of the SSE transport.
   *
   * Answers travel back over the open stream, so this replies 202 with an empty
   * body - a client reading the response body here would find nothing.
   */
  async function handleSseMessage(req, res, url) {
    const sessionId = (url.searchParams.get("sessionId") || "").trim();
    const session = sseSessions.get(sessionId);
    if (!session) {
      sendJson(
        res,
        404,
        rpcError(null, -32001, `No open SSE stream for session ${sessionId || "(missing)"}. Connect to /sse first.`)
      );
      return;
    }

    if (!isJsonRequest(req)) {
      sendJson(res, 415, rpcError(null, -32000, "Unsupported Media Type: POST bodies must be application/json"));
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, rpcError(null, -32700, err.message));
      return;
    }
    if (body === undefined) {
      sendJson(res, 400, rpcError(null, -32700, "empty body"));
      return;
    }

    const responses = await processJsonRpc(dispatcher, body, log);
    try {
      for (const response of responses) {
        session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      }
    } catch (err) {
      log(`sse write failed for ${sessionId.slice(0, 8)}: ${err.message}`);
    }

    res.writeHead(202);
    res.end();
  }

  /** GET /mcp/<token> stream connections (stateless server-initiated streams). */
  const statelessStreams = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      // No CORS headers: preflight fails, which is exactly what blocks a
      // browser-borne cross-origin request.
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // --- SSE transport --------------------------------------------------------
    // Kept for clients that only speak SSE. There is no path segment to carry
    // the token here, so it arrives through the header or the query string.
    if (pathname === "/sse" || pathname === "/message") {
      const sseBearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      const sseQueryToken = (url.searchParams.get("token") || "").trim();
      if (sseBearer !== routeToken && sseQueryToken !== routeToken) {
        log(`rejected ${req.method} ${pathname} (bad token)`);
        sendJson(res, 401, rpcError(null, -32001, "Unauthorized: invalid token"));
        return;
      }

      if (req.method === "GET" && pathname === "/sse") {
        openSseStream(req, res);
        return;
      }

      if (req.method === "POST" && pathname === "/message") {
        await handleSseMessage(req, res, url);
        return;
      }

      sendJson(res, 405, rpcError(null, -32000, `Method ${req.method} not allowed on ${pathname}`));
      return;
    }

    // --- OAuth2 endpoints (removed) ------------------------------------------
    // These used to hand the route token out at /oauth/token with no auth-code
    // validation, which reduced the whole "URL is the credential" model to
    // "URL only": anyone who could reach the tunnel could mint a token. The
    // documented clients all use the token-in-URL / Bearer path, so the surface
    // is gone rather than half-fixed.

    let area = null;
    let token = null;
    const match = /^\/(mcp|guide)\/([^/]+)$/.exec(pathname);
    if (match) {
      area = match[1];
      token = match[2];
    } else if (pathname === "/mcp") {
      area = "mcp";
      token = null;
    } else {
      sendJson(res, 404, rpcError(null, -32004, "Not found. Use /mcp/<token> or /guide/<token>."));
      return;
    }

    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const queryToken = (url.searchParams.get("token") || "").trim();
    const isAuthorized =
      (token && token === routeToken) ||
      bearer === routeToken ||
      queryToken === routeToken;

    if (!isAuthorized) {
      if (pathname === "/mcp" && req.method === "GET") {
        const base = baseUrl();
        sendJson(res, 200, {
          ok: true,
          service: "codedock",
          version: SERVER_VERSION,
          description: "VS Code Local MCP Bridge with Agentic Capabilities",
          transport: "streamable-http",
          endpoint: `${base}/mcp`,
          note: "Append the route token to the path (/mcp/<token>) or send it as an Authorization: Bearer header.",
        });
        return;
      }
      log(`rejected ${req.method} ${pathname} (bad token)`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32001, "Unauthorized: invalid or missing token")));
      return;
    }

    if (area === "guide") {
      const base = getPublicUrl() || `http://127.0.0.1:${server.address().port}`;
      const endpoint = `${base}/mcp/${routeToken}`;

      if ((url.searchParams.get("format") || "").toLowerCase() === "text") {
        const text = await guideText({
          endpoint,
          roots: roots(),
          sseUrl: `${base}/sse?token=${encodeURIComponent(routeToken)}`,
        });
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(text),
        });
        res.end(text);
        return;
      }

      const prompt = [
        "你已接通我本机编辑器的一个窗口，可以直接读写我的项目文件、执行命令、查类型错误。",
        "",
        `项目位置：${roots()[0] || "(未打开文件夹)"}`,
        "",
        "工作方式：",
        "1. 先自己看结构（find_files / search_files / read_files），不要凭猜测编造文件内容",
        "2. 改代码用 apply_patch 做精确文本替换，一次改一小段，不要整文件重写",
        "3. 每次改完调用 get_diagnostics，确认语言服务器没有报错",
        "4. 需要验证就 run_command 跑构建或测试；长任务用 wait:false，再用 get_command_output 取输出",
        "5. 查找符号用 lsp（定义 / 引用 / 悬停），比全文搜索准确",
        "6. 多步任务用 set_todos 列出计划，让我在状态栏看到进度",
        "",
        "现在先告诉我你看到的项目结构，然后等我派任务。",
      ].join("\n");
      const html = guideHtml({
        endpoint,
        prompt,
        roots: roots(),
        guideTextUrl: `${base}/guide/${routeToken}?format=text`,
        sseUrl: `${base}/sse?token=${encodeURIComponent(routeToken)}`,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    if (req.method === "GET") {
      const base = getPublicUrl() || `http://127.0.0.1:${server.address() ? server.address().port : 0}`;
      const accept = String(req.headers["accept"] || "");

      // A GET without an event-stream Accept is someone probing the endpoint
      // (curl, a script, an agent poking around). Answering with a silent SSE
      // stream just wastes their timeout - tell them how to actually talk to us.
      if (!accept.includes("text/event-stream")) {
        sendJson(res, 200, {
          ok: true,
          service: "codedock",
          version: SERVER_VERSION,
          transport: "streamable-http (stateless)",
          endpoint: `${base}/mcp`,
          note: "Use POST with a JSON-RPC body on this same URL. GET only opens a server-initiated stream, which this bridge never emits.",
          example:
            `curl -sS -X POST "${base}/mcp" ` +
            `-H "Authorization: Bearer ${routeToken}" ` +
            `-H "Content-Type: application/json" -H "ngrok-skip-browser-warning: 1" ` +
            `-d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"1"}}}'`,
          instructions: `${base}/guide/${routeToken}?format=text`,
        });
        return;
      }

      if (statelessStreams.size >= MAX_SSE_STREAMS) {
        sendJson(res, 503, rpcError(null, -32000, `too many open streams (limit ${MAX_SSE_STREAMS})`));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      statelessStreams.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(": heartbeat\n\n"); } catch {}
      }, 15000);
      const closeStream = () => {
        clearInterval(heartbeat);
        statelessStreams.delete(res);
      };
      req.on("close", closeStream);
      req.on("error", closeStream);
      return;
    }

    if (req.method === "DELETE") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, rpcError(null, -32000, `Method ${req.method} not allowed`));
      return;
    }

    if (!isJsonRequest(req)) {
      sendJson(res, 415, rpcError(null, -32000, "Unsupported Media Type: POST bodies must be application/json"));
      return;
    }

    const metricSession = metrics.startRequest(req.method, null);
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      metricSession.finish();
      sendJson(res, 400, rpcError(null, -32700, err.message));
      return;
    }
    if (body === undefined) {
      metricSession.finish();
      sendJson(res, 400, rpcError(null, -32700, "empty body"));
      return;
    }

    const responses = await processJsonRpc(dispatcher, body, log);
    const targetTool = (Array.isArray(body) ? body[0] : body)?.params?.name;
    const metricRecord = metricSession.finish(targetTool);
    if (typeof onMetric === "function") {
      try { onMetric(metricRecord); } catch {}
    }

    const timingHeaders = {
      "X-Service-Time-Ms": String(metricRecord.serviceMs),
      "X-Cycle-Time-Ms": String(metricRecord.cycleMs),
    };
    if (metricRecord.gapMs != null) {
      timingHeaders["X-Gap-Time-Ms"] = String(metricRecord.gapMs);
    }

    if (!responses.length) {
      res.writeHead(202, timingHeaders);
      res.end();
      return;
    }

    sendJson(res, 200, Array.isArray(body) ? responses : responses[0], timingHeaders);
  });

  server.on("clientError", (_err, socket) => {
    try { socket.destroy(); } catch {}
  });

  // Track every connection so shutdown can be forced. server.close() waits for
  // active connections, and the SSE / stateless event streams stay open forever
  // (heartbeats every 15s) - without this, stopping the bridge while a stream
  // client is connected hangs the stop() await indefinitely. Destroying the
  // sockets fires each request's "close" handler, which clears the heartbeat
  // timers and evicts sseSessions / statelessStreams entries.
  const openSockets = new Set();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  server.destroyConnections = () => {
    for (const socket of openSockets) {
      try { socket.destroy(); } catch {}
    }
    openSockets.clear();
  };

  return server;
}

module.exports = { createHttpServer };

