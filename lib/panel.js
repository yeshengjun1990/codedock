/**
 * Control panel webview.
 *
 * One HTML document is shared by the activity-bar view and the editor-area
 * panel; the container only decides how much room it has, and the CSS adapts.
 * All state flows in as a single `state` message so the UI never has to ask for
 * anything twice.
 */

function renderPanelHtml({ cspSource, nonce }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px 14px 28px;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: transparent;
  }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
    border-radius: 6px; padding: 12px 14px; margin-bottom: 12px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .card-head {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;
  }
  h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px;
    margin: 0; color: var(--vscode-descriptionForeground);
  }
  .action-link {
    font-size: 11px; color: var(--vscode-textLink-foreground, #3794ff);
    text-decoration: none; cursor: pointer; user-select: none;
  }
  .action-link:hover { text-decoration: underline; }

  /* Header Card */
  .header-card {
    background: linear-gradient(180deg, var(--vscode-sideBar-background, rgba(128,128,128,.08)) 0%, transparent 100%);
    border-color: var(--vscode-focusBorder, rgba(0,122,204,.35));
  }
  .status-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .status-badge { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-testing-iconFailed, #f14c4c); flex: none; box-shadow: 0 0 6px rgba(241,76,76,.4); }
  .dot.on { background: var(--vscode-testing-iconPassed, #3fb950); box-shadow: 0 0 8px rgba(63,185,80,.5); }
  .status-text { font-size: 13px; font-weight: 600; }
  .scope { color: var(--vscode-descriptionForeground); word-break: break-all; line-height: 1.6; margin-top: 6px; }
  .scope code { color: var(--vscode-foreground); background: rgba(128,128,128,.15); padding: 1px 5px; border-radius: 3px; }
  
  .endpoint {
    width: 100%; padding: 7px 9px; margin-bottom: 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
    border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; word-break: break-all;
  }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  button {
    flex: 1 1 auto; min-width: 80px;
    padding: 6px 10px; border: 1px solid transparent; border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.22));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    font-family: inherit; font-size: 12px; cursor: pointer; transition: background .15s;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.32)); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 500; }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  
  label { display: block; margin-bottom: 10px; }
  label span { display: block; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  input[type=text], input[type=number], input[type=password], select, textarea {
    width: 100%; padding: 5px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
    border-radius: 4px; font-family: inherit; font-size: 12px;
  }
  select { cursor: pointer; }
  textarea { resize: vertical; min-height: 52px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .check { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; user-select: none; }
  .check input { flex: none; cursor: pointer; }
  .check span { color: var(--vscode-foreground); cursor: pointer; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.6; margin-top: -2px; margin-bottom: 10px; }
  
  pre.logs {
    margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-all;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
    color: var(--vscode-descriptionForeground); line-height: 1.55;
  }
  .saved { color: var(--vscode-testing-iconPassed, #3fb950); margin-left: 8px; opacity: 0; transition: opacity .2s; font-size: 11px; font-weight: 600; }
  .warn {
    margin-top: 8px; padding: 8px 10px; border-radius: 4px; line-height: 1.6;
    background: var(--vscode-inputValidation-warningBackground, rgba(255,180,0,.12));
    border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,180,0,.35));
    color: var(--vscode-foreground); font-size: 11px;
  }

  /* Tunnel Presets & Dynamic Fields */
  .tunnel-preset-hint {
    padding: 8px 10px; background: rgba(63, 185, 80, 0.1);
    border: 1px solid rgba(63, 185, 80, 0.25);
    border-radius: 4px; color: var(--vscode-foreground); line-height: 1.55;
    margin-bottom: 12px; font-size: 11px;
  }
  .tunnel-fields {
    margin-top: 4px; padding: 10px 12px;
    background: var(--vscode-sideBar-background, rgba(128,128,128,0.06));
    border-radius: 4px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
    margin-bottom: 12px;
  }

  /* Collapsible Advanced Section */
  details.advanced-section {
    margin-top: 14px; margin-bottom: 8px;
    border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.25));
    padding-top: 8px;
  }
  details.advanced-section summary {
    cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px;
    user-select: none; outline: none; transition: color .15s;
  }
  details.advanced-section summary:hover { color: var(--vscode-foreground); }
  .advanced-content { margin-top: 10px; }

  /* ========================================================================= */
  /* Unified Agent Execution & Progress Board                                  */
  /* ========================================================================= */
  .exec-board {
    border-color: var(--vscode-focusBorder, rgba(0,122,204,.35));
    box-shadow: 0 1px 4px rgba(0,0,0,0.12);
  }
  .active-badge {
    display: inline-flex; align-items: center; gap: 6px; font-size: 11px;
    padding: 2px 8px; border-radius: 12px; background: rgba(128,128,128,.14);
    color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums;
  }
  .active-badge.running {
    background: rgba(14, 112, 192, 0.2); color: var(--vscode-progressBar-background, #3794ff);
    font-weight: 500;
  }
  .active-dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground);
  }
  .active-badge.running .active-dot {
    background: var(--vscode-progressBar-background, #3794ff);
    box-shadow: 0 0 6px rgba(55,148,255,0.6);
    animation: badge-pulse 1.4s infinite;
  }
  @keyframes badge-pulse {
    0% { transform: scale(0.9); opacity: 0.6; }
    50% { transform: scale(1.3); opacity: 1; }
    100% { transform: scale(0.9); opacity: 0.6; }
  }

  .board-progress {
    margin-bottom: 12px; padding: 8px 10px;
    background: var(--vscode-sideBar-background, rgba(128,128,128,0.06));
    border-radius: 5px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
  }
  .prog-head {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 8px;
  }
  .prog-info {
    display: flex; align-items: center; gap: 6px; overflow: hidden; flex: 1; min-width: 0;
  }
  .prog-tag {
    font-size: 10px; padding: 1px 6px; border-radius: 3px;
    background: rgba(14, 112, 192, 0.18); color: var(--vscode-textLink-foreground, #3794ff);
    font-weight: 600; flex: none;
  }
  .prog-msg {
    font-size: 11px; color: var(--vscode-foreground); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
  }
  .prog-pct {
    font-size: 12px; font-weight: 600; color: var(--vscode-foreground);
    margin-left: 8px; flex: none; font-variant-numeric: tabular-nums;
  }
  .prog-bar {
    height: 6px; border-radius: 3px; background: rgba(128,128,128,.2); overflow: hidden;
  }
  .prog-fill {
    height: 100%; width: 0; border-radius: 3px;
    background: var(--vscode-progressBar-background, #0e70c0);
    transition: width .35s ease;
  }

  .board-section {
    margin-bottom: 14px;
  }
  .section-subhead {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 6px; font-size: 11px; font-weight: 600; color: var(--vscode-foreground);
  }
  .subhead-pill {
    font-size: 10px; font-weight: normal; color: var(--vscode-descriptionForeground);
    background: rgba(128,128,128,.12); padding: 1px 6px; border-radius: 10px;
  }

  .todo-list {
    max-height: 140px; overflow-y: auto; margin-bottom: 2px;
  }
  .todo-item {
    display: flex; align-items: flex-start; gap: 7px; padding: 4px 6px;
    border-radius: 4px; font-size: 11px; line-height: 1.45; margin-bottom: 2px;
  }
  .todo-item.in_progress {
    background: rgba(14, 112, 192, 0.12);
    border-left: 2px solid var(--vscode-progressBar-background, #0e70c0);
    font-weight: 500;
  }
  .todo-item .ic { flex: none; line-height: 1.4; width: 12px; text-align: center; }
  .todo-item .title { flex: 1; word-break: break-word; }

  .empty-hint {
    font-size: 11px; color: var(--vscode-descriptionForeground); padding: 6px 0;
    line-height: 1.5; font-style: italic;
  }

  .stats { font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 6px; font-size: 11px; }
  #activity { max-height: 250px; overflow-y: auto; }
  .act { display: flex; align-items: baseline; gap: 6px; padding: 4px 2px; font-size: 11px; line-height: 1.5; border-bottom: 1px solid rgba(128,128,128,0.06); }
  .act:last-child { border-bottom: none; }
  .act .ic { flex: none; width: 11px; text-align: center; }
  .act .nm { flex: none; font-family: var(--vscode-editor-font-family, monospace); font-weight: 500; }
  .act .sum { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
  .act .meta { flex: none; color: var(--vscode-testing-iconPassed, #3fb950); font-variant-numeric: tabular-nums; font-size: 10px; background: rgba(63, 185, 80, 0.12); padding: 0 4px; border-radius: 3px; }
  .act.clickable { cursor: pointer; border-radius: 3px; }
  .act.clickable:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  .act .ms { flex: none; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; font-size: 10px; }
  .ic.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .ic.err { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .ic.run { color: var(--vscode-progressBar-background, #0e70c0); animation: badge-pulse 1s infinite; display: inline-block; }
  .act.err .nm { color: var(--vscode-testing-iconFailed, #f14c4c); }
</style>
</head>
<body>

<!-- 1. 服务主状态与启停操作 -->
<div class="card header-card">
  <div class="status-row">
    <div class="status-badge">
      <span class="dot" id="dot"></span>
      <span class="status-text" id="statusText">读取状态中…</span>
    </div>
    <div class="row" style="flex:0 0 auto; gap:6px">
      <button class="primary" id="btnStart" style="min-width:76px; padding:5px 12px">启动服务</button>
      <button id="btnStop" style="min-width:76px; padding:5px 12px">停止服务</button>
    </div>
  </div>
  <div class="scope" id="scope"></div>
  <div class="scope" id="health" style="font-size:11px; margin-top:4px"></div>
  <div class="hint" style="margin:6px 0 0" id="tunnelHint"></div>
</div>

<!-- 2. Agent 执行看板（合并：进度 + 规划任务 + 实时工具流水） -->
<div class="card exec-board">
  <div class="card-head">
    <h2>Agent 执行看板 <span class="stats" id="stats"></span></h2>
    <span class="active-badge" id="activeBadge">
      <span class="active-dot"></span>
      <span id="activeText">就绪</span>
    </span>
  </div>

  <!-- 2.1 总体进度条 -->
  <div class="board-progress">
    <div class="prog-head">
      <div class="prog-info">
        <span class="prog-tag" id="progPhase">就绪</span>
        <span class="prog-msg" id="progMsg">等待任务触发</span>
      </div>
      <span class="prog-pct" id="progPct">0%</span>
    </div>
    <div class="prog-bar"><div class="prog-fill" id="progFill"></div></div>
  </div>

  <!-- 2.2 任务规划清单 -->
  <div class="board-section">
    <div class="section-subhead">
      <span>📋 任务规划清单</span>
      <span class="subhead-pill" id="todoStats">无任务</span>
    </div>
    <div class="todo-list" id="todoList">
      <div class="empty-hint">暂无任务规划清单（等待 Agent 调用 set_todos 或 update_plan）</div>
    </div>
  </div>

  <!-- 2.3 实时工具调用流 -->
  <div class="board-section" style="margin-bottom:0">
    <div class="section-subhead">
      <span>⚡ 实时工具调用流</span>
      <span style="font-size:10px; color:var(--vscode-descriptionForeground)">点击条目可对比改动 Diff</span>
    </div>
    <div id="activity"></div>
  </div>
</div>

<!-- 3. 连接地址 -->
<div class="card">
  <div class="card-head">
    <h2>连接地址</h2>
    <a href="#" class="action-link" id="btnRegenToken" title="重新生成随机安全访问令牌">🔄 重置令牌</a>
  </div>
  <input class="endpoint" id="endpoint" readonly value="" placeholder="(服务未启动)">
  <div class="row">
    <button class="primary" id="btnCopy">复制地址</button>
    <button id="btnCopyPrompt">复制接入语句</button>
  </div>
  <div class="hint" style="margin:8px 0 0">
    在网页端 AI（Claude / ChatGPT / Grok）设置中添加自定义连接器并粘贴上方地址；也可将「接入语句」发给支持对话握手的 Agent。
  </div>
  <div class="warn" id="tokenWarn" style="display:none">
    ⚠ 该地址是工作区的访问钥匙，请勿公开或截图。如遇泄露，可点击右上角「重置令牌」立即失效。
  </div>
</div>

<!-- 4. 访问权限控制 -->
<div class="card">
  <div class="card-head">
    <h2>访问权限控制</h2>
  </div>
  <div id="permList"></div>
  <div class="check" style="margin-top:6px;padding-top:8px;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.25))">
    <input type="checkbox" id="allowOutside">
    <span><b>允许访问工作区之外的所有路径</b>
    <div style="color:var(--vscode-descriptionForeground);font-size:11px;line-height:1.5">
    开启后远程工具可访问本机任意目录，不再弹出越界授权窗；关闭时越界访问需在弹窗中按会话逐目录确认。</div></span>
  </div>
  <div class="hint" style="margin:8px 0 0">
    权限更改即刻生效。未授权的操作会被直接拒绝，并在实时活动中记录。
  </div>
</div>

<!-- 5. 参数配置（精简、智能联动、无繁琐路径输入） -->
<div class="card">
  <div class="card-head">
    <h2>参数配置</h2>
  </div>

  <label><span>公网隧道方式</span>
    <select id="tunnelProvider">
      <option value="cloudflared">⚡ cloudflared 快速隧道（免注册 · 自动分配 · 开箱即用 · 推荐）</option>
      <option value="cloudflare-named">🌐 cloudflare-named 具名隧道（固定域名 · 无限流量）</option>
      <option value="ngrok">🚀 ngrok 隧道（固定域名 · 需 Token）</option>
    </select>
  </label>

  <!-- 1) 选 cloudflared: 纯零配置 -->
  <div class="tunnel-preset-hint" id="hintCloudflared">
    ⚡ <b>零配置免注册</b>：插件已内置快速隧道，启动时自动向 Cloudflare 请求临时公网域名，开箱即用，无需填写任何凭据。
  </div>

  <!-- 2) 选 cloudflare-named: 仅显示必须填的令牌和域名 -->
  <div id="fieldsCloudflareNamed" class="tunnel-fields" style="display:none">
    <label><span>Cloudflare 具名隧道令牌 (Token)</span><input type="text" id="cloudflareTunnelToken" placeholder="Zero Trust → Tunnels → 复制令牌"></label>
    <label><span>Cloudflare 固定域名 (Hostname)</span><input type="text" id="cloudflareHostname" placeholder="例如 mcp.example.com"></label>
    <div class="hint" style="margin-bottom:0">固定域名 + 无限流量 + 免费。需要 Cloudflare 账号并在隧道中把 Public Hostname 指向 127.0.0.1:8787。</div>
  </div>

  <!-- 3) 选 ngrok: 仅显示 authtoken 和固定域名 -->
  <div id="fieldsNgrok" class="tunnel-fields" style="display:none">
    <label><span>ngrok authtoken</span><input type="text" id="ngrokAuthtoken" placeholder="从 ngrok 控制台获取"></label>
    <label><span>ngrok 固定域名（可选）</span><input type="text" id="ngrokDomain" placeholder="例如 your-name.ngrok-free.app，留空用随机域名"></label>
  </div>


  <details class="advanced-section">
    <summary>⚙️ 高级选项（端口 / 路径说明）</summary>
    <div class="advanced-content">
      <label><span>本地监听端口（默认 8787，无冲突无需修改）</span><input type="number" id="port" min="1024" max="65535" placeholder="8787"></label>
      <div class="hint" style="margin-top:6px">
        💡 <b>智能自动检测</b>：dotnet、Godot、系统 Shell 与隧道客户端均由插件<b>自动检测并就绪</b>，无需繁琐的人工路径配置。<br>
        如需覆盖特定路径或配置多进程 MCP 聚合网关，可在 VS Code 设置中搜索 <code>codedock</code> 轻松修改。
      </div>
    </div>
  </details>

  <div class="row" style="margin-top:10px">
    <button class="primary" id="btnSave">保存设置</button>
    <button id="btnReload">放弃修改</button>
    <span class="saved" id="savedMark">✓ 已保存</span>
  </div>
  <div class="hint" style="margin-top:8px">修改隧道方式或端口后，需要重启服务才会生效。</div>
</div>

<!-- 6. 日志卡片 -->
<div class="card">
  <div class="card-head">
    <h2>运行日志</h2>
  </div>
  <pre class="logs" id="logs">(暂无日志)</pre>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let tokenShown = false;

  function updateTunnelFields() {
    const val = $('tunnelProvider') ? $('tunnelProvider').value : 'cloudflared';
    if ($('hintCloudflared')) $('hintCloudflared').style.display = val === 'cloudflared' ? '' : 'none';
    if ($('fieldsCloudflareNamed')) $('fieldsCloudflareNamed').style.display = val === 'cloudflare-named' ? '' : 'none';
    if ($('fieldsNgrok')) $('fieldsNgrok').style.display = val === 'ngrok' ? '' : 'none';
  }

  function applyState(state) {
    if ($('dot')) $('dot').className = 'dot' + (state.running ? ' on' : '');
    if ($('statusText')) $('statusText').textContent = state.running
      ? (state.busy ? '启动中…' : '运行中')
      : (state.busy ? '停止中…' : '已停止');

    const scopeEl = $('scope');
    if (scopeEl) {
      scopeEl.innerHTML = state.roots.length
        ? '操作范围：' + state.roots.map((r) => '<code>' + escapeHtml(r) + '</code>').join(' ')
        : '⚠ 当前窗口没有打开文件夹 —— 没有范围就没有授权，启动前请先打开一个文件夹。';
    }

    var h = state.health;
    if ($('health')) {
      if (h) {
        var bits = [];
        bits.push('本地 ' + (h.local && h.local.ok ? '✓ ' + h.local.latencyMs + 'ms' : '✗ 不通'));
        if (h.public) bits.push('公网 ' + (h.public.ok ? '✓ ' + h.public.latencyMs + 'ms' : '✗ 不通'));
        bits.push('隧道进程 ' + (h.tunnelAlive ? '存活' : '已退出'));
        $('health').textContent = bits.join(' · ');
      } else {
        $('health').textContent = '';
      }
    }

    if ($('endpoint')) {
      $('endpoint').value = state.endpoint || (state.running ? '(隧道未就绪，稍后点刷新)' : '(服务未启动)');
    }
    if ($('tokenWarn')) {
      $('tokenWarn').style.display = state.running && state.endpoint ? 'block' : 'none';
    }

    if ($('btnStart')) $('btnStart').disabled = state.running || state.busy;
    if ($('btnStop')) $('btnStop').disabled = !state.running || state.busy;
    if ($('btnCopy')) $('btnCopy').disabled = !state.endpoint;
    if ($('btnCopyPrompt')) $('btnCopyPrompt').disabled = !state.endpoint;

    const hint = state.tunnelMessage
      || (state.tunnelProvider === 'none'
        ? '隧道已关闭，仅本机 127.0.0.1 可访问。'
        : '当前方式：' + state.tunnelProvider + '（重启后域名会重新分配）');
    if ($('tunnelHint')) $('tunnelHint').textContent = hint;

    const cfg = state.config || {};
    if (!tokenShown || document.activeElement.tagName !== 'INPUT') {
      if ($('port')) $('port').value = cfg.port || 8787;
      if ($('tunnelProvider')) $('tunnelProvider').value = cfg.tunnelProvider || 'cloudflared';
      if ($('ngrokAuthtoken')) $('ngrokAuthtoken').value = cfg.ngrokAuthtoken || '';
      if ($('ngrokDomain')) $('ngrokDomain').value = cfg.ngrokDomain || '';
      if ($('cloudflareTunnelToken')) $('cloudflareTunnelToken').value = cfg.cloudflareTunnelToken || '';
      if ($('cloudflareHostname')) $('cloudflareHostname').value = cfg.cloudflareHostname || '';
      tokenShown = true;
      updateTunnelFields();
    }

    if ($('logs')) {
      $('logs').textContent = state.logs && state.logs.length ? state.logs.join('\\n') : '(暂无日志)';
    }

    renderPermissions(state);
    if ($('allowOutside')) $('allowOutside').checked = !!state.allowOutsideWorkspace;
    renderUnifiedBoard(state);
  }

  function renderUnifiedBoard(state) {
    var p = state.progress;
    var todos = state.todos || [];
    var done = todos.filter(function (t) { return t.status === 'completed'; }).length;
    var inProg = todos.find(function (t) { return t.status === 'in_progress'; });
    var activeTool = state.activeTool;

    // 1. Active Tool Indicator Badge
    var activeBadge = $('activeBadge');
    var activeText = $('activeText');
    if (activeBadge && activeText) {
      if (activeTool) {
        activeBadge.className = 'active-badge running';
        activeText.textContent = '运行中: ' + activeTool;
      } else if (state.running) {
        activeBadge.className = 'active-badge';
        activeText.textContent = '就绪 (等待调用)';
      } else {
        activeBadge.className = 'active-badge';
        activeText.textContent = '已停止';
      }
    }

    // 2. Accurate Progress Bar & Phase Info
    var percent = (p && p.percent != null)
      ? p.percent
      : (todos.length ? Math.round((done / todos.length) * 100) : (state.running ? 0 : 0));

    var phase = (p && p.phase)
      ? p.phase
      : (inProg ? ('任务 ' + inProg.id) : (todos.length && done === todos.length ? '全部达成' : (activeTool ? '执行中' : '就绪')));

    var msg = (p && p.message)
      ? p.message
      : (inProg ? inProg.title : (todos.length ? (done + '/' + todos.length + ' 项完成') : '等待 Agent 发起任务'));

    if ($('progPhase')) $('progPhase').textContent = phase;
    if ($('progMsg')) {
      $('progMsg').textContent = msg;
      $('progMsg').title = msg;
    }
    if ($('progPct')) $('progPct').textContent = percent + '%';
    if ($('progFill')) $('progFill').style.width = percent + '%';

    // 3. Task / Todo Plan List
    if ($('todoStats')) {
      $('todoStats').textContent = todos.length ? (done + '/' + todos.length + ' 完成') : '无任务';
    }
    if ($('todoList')) {
      if (!todos.length) {
        $('todoList').innerHTML = '<div class="empty-hint">暂无任务规划清单（等待 Agent 调用 set_todos 或 update_plan）</div>';
      } else {
        $('todoList').innerHTML = todos.map(function (t) {
          var isDone = t.status === 'completed';
          var isCur = t.status === 'in_progress';
          var icon = isDone ? '✓' : isCur ? '⟳' : '○';
          var cls = isDone ? 'ok' : isCur ? 'run in_progress' : 'pending';
          return '<div class="todo-item ' + cls + '">' +
            '<span class="ic ' + (isDone ? 'ok' : isCur ? 'run' : '') + '">' + icon + '</span>' +
            '<span class="title" style="' + (isDone ? 'text-decoration:line-through;opacity:0.7;' : '') + '">' +
            escapeHtml(t.id ? t.id + '. ' + t.title : t.title) + '</span></div>';
        }).join('');
      }
    }

    // 4. Live Activity Stream
    renderActivities(state);
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderActivities(state) {
    var list = state.activities || [];
    var stats = state.stats || { calls: 0, failed: 0, totalMs: 0 };

    var label = stats.calls
      ? stats.calls + ' 次 · 失败 ' + stats.failed + ' · 本地 ' + Math.round(stats.totalMs / stats.calls) + 'ms'
      : '';
    var m = state.metrics;
    if (m && m.requests > 0) {
      label += (label ? ' · ' : '') + 'AI等待 ' + (m.avgGapMs < 1000 ? m.avgGapMs + 'ms' : (m.avgGapMs / 1000).toFixed(1) + 's');
    }
    var conc = state.concurrency;
    if (conc && (conc.queued > 0 || conc.ceiling !== 8)) {
      label += (label ? ' · ' : '') + '并发 ' + conc.inFlight + '/' + conc.ceiling;
    }
    if ($('stats')) $('stats').textContent = label;

    if (!list.length) {
      if ($('activity')) $('activity').innerHTML = '<div class="empty-hint">还没有工具调用。网页端 AI 开始干活后，这里会实时显示调用的每个工具、精确参数、耗时与改动对比。</div>';
      return;
    }

    if ($('activity')) {
      $('activity').innerHTML = list.map(function (a) {
        var status = a.status || 'running';
        var icon = status === 'running' ? '⟳' : status === 'ok' ? '✓' : '✗';
        var cls = status === 'running' ? 'run' : status === 'ok' ? 'ok' : 'err';
        var ms = a.ms == null ? '执行中...' : (a.ms < 1000 ? a.ms + 'ms' : (a.ms / 1000).toFixed(1) + 's');
        var canDiff = !!(a.rawMeta && a.rawMeta.beforePath);
        var gap = a.gapMs != null ? ' (等待AI: ' + (a.gapMs < 1000 ? a.gapMs + 'ms' : (a.gapMs / 1000).toFixed(1) + 's') + ')' : '';
        var hint = (canDiff ? '点击查看 diff · ' : '') + (a.detail || '') + gap;
        var summaryText = a.summary ? escapeHtml(a.summary) : '';
        return '<div class="act' + (status === 'error' ? ' err' : '') + (canDiff ? ' clickable' : '') +
          '" data-id="' + a.id + '" title="' + escapeHtml(hint) + '">' +
          '<span class="ic ' + cls + '">' + icon + '</span>' +
          '<span class="nm">' + escapeHtml(a.name) + '</span>' +
          '<span class="sum">' + summaryText + '</span>' +
          (a.meta ? '<span class="meta">' + escapeHtml(a.meta) + '</span>' : '') +
          '<span class="ms">' + ms + '</span>' +
          '</div>';
      }).join('');
    }
  }

  function renderPermissions(state) {
    var list = state.permissions || [];
    var counts = state.permissionCounts || {};
    if ($('permList')) {
      $('permList').innerHTML = list.map(function (p) {
        var n = counts[p.level] || 0;
        return '<div class="check">' +
          '<input type="checkbox" data-level="' + p.level + '"' + (p.enabled ? ' checked' : '') + '>' +
          '<span><b>' + escapeHtml(p.label) + '</b>' +
          '<span style="color:var(--vscode-descriptionForeground)"> · ' + n + ' 个工具</span>' +
          '<div style="color:var(--vscode-descriptionForeground);font-size:11px;line-height:1.5">' +
          escapeHtml(p.blurb) + '</div></span>' +
          '</div>';
      }).join('');
    }
  }

  function collect() {
    const prov = $('tunnelProvider') ? $('tunnelProvider').value : 'cloudflared';
    const data = {
      tunnelProvider: prov,
    };
    if ($('port') && $('port').value) {
      data.port = Number($('port').value) || 8787;
    }
    if (prov === 'cloudflare-named') {
      if ($('cloudflareTunnelToken')) data.cloudflareTunnelToken = $('cloudflareTunnelToken').value.trim();
      if ($('cloudflareHostname')) data.cloudflareHostname = $('cloudflareHostname').value.trim();
    } else if (prov === 'ngrok') {
      if ($('ngrokAuthtoken')) data.ngrokAuthtoken = $('ngrokAuthtoken').value.trim();
      if ($('ngrokDomain')) data.ngrokDomain = $('ngrokDomain').value.trim();
    }
    return data;
  }

  if ($('tunnelProvider')) {
    $('tunnelProvider').addEventListener('change', updateTunnelFields);
  }

  if ($('btnStart')) $('btnStart').addEventListener('click', () => vscode.postMessage({ type: 'start' }));
  if ($('btnStop')) $('btnStop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  if ($('btnCopy')) $('btnCopy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  if ($('btnCopyPrompt')) $('btnCopyPrompt').addEventListener('click', () => vscode.postMessage({ type: 'copyPrompt' }));
  if ($('btnReload')) $('btnReload').addEventListener('click', () => { tokenShown = false; vscode.postMessage({ type: 'refresh' }); });
  
  if ($('btnRegenToken')) {
    $('btnRegenToken').addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'regenerateToken' });
    });
  }

  if ($('btnSave')) {
    $('btnSave').addEventListener('click', () => {
      vscode.postMessage({ type: 'save', values: collect() });
      const mark = $('savedMark');
      if (mark) {
        mark.style.opacity = 1;
        setTimeout(() => { mark.style.opacity = 0; }, 1600);
      }
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') applyState(message.state);
  });

  if ($('permList')) {
    $('permList').addEventListener('change', function (event) {
      var box = event.target;
      if (!box || box.type !== 'checkbox') return;
      var level = box.getAttribute('data-level');
      if (!level) return;
      vscode.postMessage({ type: 'setPermission', level: level, enabled: box.checked });
    });
  }

  if ($('allowOutside')) {
    $('allowOutside').addEventListener('change', function (event) {
      vscode.postMessage({ type: 'setAllowOutside', enabled: event.target.checked });
    });
  }

  if ($('activity')) {
    $('activity').addEventListener('click', function (event) {
      var row = event.target && event.target.closest ? event.target.closest('.act.clickable') : null;
      if (!row) return;
      vscode.postMessage({ type: 'openDiff', id: Number(row.getAttribute('data-id')) });
    });
  }

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { renderPanelHtml };
