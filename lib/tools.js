/**
 * Tool registry - the single place that knows the full MCP surface.
 *
 * Adding a tool means adding it to one of the module lists; the MCP schema, the
 * initialization instructions and the dispatch table all follow automatically.
 */

const files = require("./tools-files");
const exec = require("./tools-exec");
const ide = require("./tools-ide");
const dotnet = require("./tools-dotnet");
const godot = require("./tools-godot");
const git = require("./tools-git");
const skills = require("./tools-skills");
const custom = require("./tools-custom");
const policy = require("./policy");
const gateway = require("./gateway");

const ALL = [
  ...files.TOOLS,
  ...skills.TOOLS,
  ...exec.TOOLS,
  ...ide.TOOLS,
  ...git.TOOLS,
  ...dotnet.TOOLS,
  ...godot.TOOLS,
];
const BY_NAME = new Map(ALL.map((tool) => [tool.name, tool]));

/** Where problems with workspace-declared tools are reported. */
let logSink = () => {};
function setLogSink(fn) {
  logSink = typeof fn === "function" ? fn : () => {};
  gateway.setLogSink(logSink);
}

function describe(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** Built-ins plus whatever the workspace declares in .codedock/tools and external gateway. */
async function allTools() {
  const declared = await custom.loadCustomTools(logSink);
  const external = await gateway.listAggregatedTools();
  return [
    ...ALL,
    ...declared.filter((tool) => !BY_NAME.has(tool.name)),
    ...external,
  ];
}

async function listTools() {
  const list = await allTools();
  return list.map(describe);
}

async function toolNames() {
  const list = await allTools();
  return list.map((tool) => tool.name);
}

/**
 * Activity observer.
 *
 * The editor UI wants to show what the remote client is doing right now, so
 * every call reports a start and an end event. Observation must never be able to
 * break a tool call, hence the swallowed errors.
 */
let observer = null;
let nextActivityId = 1;

/**
 * Tools that exist to inspect or stop work must never wait behind the queue -
 * otherwise a saturated bridge could not be polled or cancelled.
 */
const NEVER_QUEUE = new Set(["cancel_command", "get_command_output", "send_command_input", "report_progress", "list_jobs"]);

/** Above this average, the host is struggling and the ceiling comes down. */
const SLOW_CALL_MS = 3000;
const MAX_QUEUED_CALLS = 200;

/**
 * Concurrency governor.
 *
 * A burst of parallel tool calls is normal for agents, but nothing caps it on
 * the MCP side: twenty simultaneous run_command calls would happily start twenty
 * processes. This keeps a ceiling that adapts to how the host is actually
 * coping - up while calls stay fast and work is waiting, down when calls fail or
 * slow down.
 */
class AdaptiveLimiter {
  constructor({ initial = 8, min = 2, max = 32 } = {}) {
    this.ceiling = initial;
    this.min = min;
    this.max = max;
    this.inFlight = 0;
    this.waiting = [];
    this.successStreak = 0;
    this.recentMs = [];
  }

  get pending() {
    return this.waiting.length;
  }

  acquire() {
    if (this.inFlight < this.ceiling) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= MAX_QUEUED_CALLS) {
      return Promise.reject(new Error(`too many queued tool calls (${MAX_QUEUED_CALLS}); let some finish first`));
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release() {
    const next = this.waiting.shift();
    if (next) {
      next(); // the permit passes straight to the next waiter
      return;
    }
    this.inFlight -= 1;
  }

  record({ durationMs, failed, queued }) {
    this.recentMs.push(durationMs);
    if (this.recentMs.length > 20) this.recentMs.shift();
    const avgMs = this.recentMs.reduce((sum, value) => sum + value, 0) / this.recentMs.length;

    if (failed) {
      this.ceiling = Math.max(this.min, this.ceiling - 1);
      this.successStreak = 0;
      return;
    }

    if (avgMs > SLOW_CALL_MS) {
      this.ceiling = Math.max(this.min, this.ceiling - 1);
      this.successStreak = 0;
      return;
    }

    if (queued > 0 && this.ceiling < this.max) {
      // Demand exceeds the ceiling and calls are still fast: allow more.
      this.ceiling += 1;
      this.successStreak = 0;
      return;
    }

    this.successStreak += 1;
    if (this.successStreak >= 6 && this.ceiling < this.max) {
      this.ceiling += 1;
      this.successStreak = 0;
    }
  }

  stats() {
    return { ceiling: this.ceiling, inFlight: this.inFlight, queued: this.waiting.length };
  }
}

const limiter = new AdaptiveLimiter();

function setObserver(fn) {
  observer = fn;
}

function emit(event) {
  if (!observer) return;
  try {
    observer(event);
  } catch {}
}

/** One-line argument digest, so the activity feed says accurately what a call touched. */
function summarizeArgs(name, args) {
  if (!args || typeof args !== "object") return "";

  if (name === "read_skill") {
    return `规范: ${args.skill_id || ""}${args.resource_path ? ` (${args.resource_path})` : ""}`;
  }
  if (name === "list_skills") {
    return "扫描工作区规范清单";
  }
  if (name === "list_jobs") {
    return `后台任务清单 (limit: ${args.limit || 20})`;
  }
  if (name === "get_command_output") {
    return `任务 #${args.command_id || ""}${args.offset != null ? ` (游标: ${args.offset})` : ""}`;
  }
  if (name === "send_command_input") {
    return `任务 #${args.command_id || ""} 写入输入`;
  }
  if (name === "cancel_command") {
    return `终止任务 #${args.command_id || ""}`;
  }
  if (name === "report_progress") {
    const p = args.percent != null ? `${args.percent}% ` : "";
    return `${args.phase ? `[${args.phase}] ` : ""}${p}${args.message || ""}`;
  }
  if (name === "set_todos") {
    return Array.isArray(args.todos) ? `${args.todos.length} 项任务规划` : "";
  }
  if (name === "update_plan") {
    return Array.isArray(args.plan) ? `${args.plan.length} 步计划更新` : "";
  }
  if (name === "get_diagnostics") {
    return args.file_path || "所有打开文档诊断";
  }
  if (name === "lsp") {
    return `${args.operation || "nav"} ${args.file_path || ""}${args.line ? `:${args.line}` : ""}`;
  }
  if (name === "apply_patch") {
    const editCount = Array.isArray(args.edits) ? `${args.edits.length} 处替换` : "整文件写入";
    return `${args.file_path || ""} (${editCount})`;
  }
  if (name === "read_files") {
    if (Array.isArray(args.paths)) {
      const shown = args.paths.slice(0, 2).join(", ");
      return `${args.paths.length} 个文件: ${shown}${args.paths.length > 2 ? "..." : ""}`;
    }
    return args.path || "";
  }
  if (name === "read_image") {
    return `查看图片: ${args.path || ""}`;
  }
  if (name === "list_directory") {
    return args.path || "工作区根目录";
  }
  if (name === "find_files") {
    return `查找: ${args.glob || ""}`;
  }
  if (name === "search_files") {
    return `"${args.query || ""}"${args.include ? ` in ${args.include}` : ""}`;
  }
  if (name === "run_command") {
    return String(args.command || "");
  }
  if (name && name.includes("__")) {
    const parts = name.split("__");
    const firstVal = Object.values(args)[0];
    return `[${parts[0]}] ${firstVal ? String(firstVal).slice(0, 60) : ""}`;
  }

  const pick =
    args.file_path ||
    args.paths ||
    args.path ||
    args.command ||
    args.glob ||
    args.query ||
    args.pattern ||
    args.message ||
    args.text ||
    args.name ||
    args.operation;
  if (!pick) {
    if (Array.isArray(args.todos)) return `${args.todos.length} 项任务`;
    if (Array.isArray(args.plan)) return `${args.plan.length} 步计划`;
    const keys = Object.keys(args);
    if (keys.length === 1 && typeof args[keys[0]] === "string") return `${keys[0]}: ${args[keys[0]]}`;
    return "";
  }
  const text = Array.isArray(pick) ? pick.join(", ") : String(pick);
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 90 ? `${single.slice(0, 90)}…` : single;
}

async function callTool(name, args) {
  let tool = BY_NAME.get(name);
  if (!tool) {
    const declared = await custom.loadCustomTools(logSink);
    tool = declared.find((entry) => entry.name === name);
  }
  if (!tool) {
    tool = gateway.findTool(name);
  }

  const id = nextActivityId++;
  const summary = summarizeArgs(name, args);
  const startedAt = Date.now();

  if (!tool) {
    // Surfaced in the activity feed too: a client calling a name that does not
    // exist is worth seeing, not worth hiding.
    const message = `unknown tool "${name}". Available: ${(await toolNames()).join(", ")}`;
    emit({ phase: "start", id, name, summary });
    emit({ phase: "end", id, name, summary, ok: false, ms: 0, error: message });
    throw new Error(message);
  }

  // Permission gate. Refuses before anything is queued or started, and records
  // the refusal so the control panel can show it as a blocked call instead of
  // the model's claim going unverified.
  try {
    policy.ensureAllowed(name);
  } catch (err) {
    emit({ phase: "start", id, name, summary });
    emit({ phase: "end", id, name, summary, ok: false, ms: 0, error: err.message, denied: true });
    throw err;
  }

  const queueable = !NEVER_QUEUE.has(name);
  const queuedBefore = limiter.pending;
  if (queueable) await limiter.acquire();

  emit({ phase: "start", id, name, summary });

  try {
    const result = await tool.run(args || {});

    // Three shapes are accepted, so tools can pick whichever fits:
    //   - a full MCP content array, for anything richer than text (image blocks)
    //   - { text, meta }, where meta feeds the activity feed as real data
    //     instead of being parsed back out of the rendered text
    //   - plain text
    let content;
    let meta;
    if (Array.isArray(result)) {
      content = result;
    } else if (result && typeof result === "object" && typeof result.text === "string") {
      content = [{ type: "text", text: result.text }];
      meta = result.meta;
    } else {
      content = [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }];
    }

    if (!meta) {
      if (name === "find_files" && typeof result === "string") {
        const lines = result.trim().split("\n").filter(Boolean);
        meta = { count: lines.length };
      } else if (name === "search_files" && typeof result === "string") {
        const lines = result.trim().split("\n").filter(Boolean);
        meta = { matches: lines.length };
      } else if (name === "list_skills" && typeof result === "string") {
        const matchCount = (result.match(/- \*\*/g) || []).length;
        meta = { count: matchCount };
      } else if (name === "read_files" && Array.isArray(args.paths)) {
        meta = { files: args.paths.length };
      } else if (name === "list_jobs" && typeof result === "string") {
        const m = result.match(/Jobs \((\d+) recorded\)/);
        meta = { count: m ? Number(m[1]) : 0 };
      }
    }

    const firstText = content.find((part) => part && part.type === "text");
    const preview = firstText
      ? firstText.text.replace(/\s+/g, " ").trim().slice(0, 160)
      : `(${content.length} non-text part(s))`;

    const ms = Date.now() - startedAt;
    emit({ phase: "end", id, name, summary, ok: true, ms, preview, meta });
    limiter.record({ durationMs: ms, failed: false, queued: queuedBefore });
    return { content };
  } catch (err) {
    const ms = Date.now() - startedAt;
    emit({ phase: "end", id, name, summary, ok: false, ms, error: err.message });
    limiter.record({ durationMs: ms, failed: isInfrastructureFailure(err.message), queued: queuedBefore });
    throw err;
  } finally {
    if (queueable) limiter.release();
  }
}

/**
 * Only host-level trouble should pull the ceiling down.
 *
 * A tool that fails because the caller asked for something impossible (a patch
 * whose anchor text is not in the file, a path outside the workspace) says
 * nothing about how many calls the machine can take, and treating it as pressure
 * would quietly throttle the bridge over ordinary model mistakes.
 */
function isInfrastructureFailure(message) {
  return /timeout|timed out|exited|ENOENT|EACCES|EPERM|spawn|too many queued/i.test(String(message || ""));
}

/** Current concurrency governor state, for the UI. */
function concurrency() {
  return limiter.stats();
}

module.exports = { listTools, callTool, toolNames, setObserver, setLogSink, concurrency, ide, policy };

