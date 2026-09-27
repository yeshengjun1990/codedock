/**
 * Git toolchain.
 *
 * Structured git tools so the agent does not have to drive `run_command` for
 * everyday version control. The value mirrors the dotnet wrappers: resolved
 * repository, parsed porcelain output, and capability levels that match what
 * each operation can actually do:
 *
 *   read    - status / diff / log / show / branch: inspect, change nothing
 *   edit    - stage / commit / checkout: rewrite local repository state only,
 *             same blast radius as apply_patch (and recoverable via git)
 *   execute - push / pull: touch the network / remotes
 *
 * Every invocation uses execFile with an ARGUMENT ARRAY - no shell is involved,
 * so quoting/injection is structurally impossible. Force pushes, hard resets
 * and friends are deliberately NOT exposed here; those still go through
 * run_command where the destructive-command guard asks the user first.
 */

const { execFile } = require("child_process");
const vscode = require("vscode");
const scope = require("./scope");

const GIT_TIMEOUT_MS = 60000;
const MAX_BUFFER = 10 * 1024 * 1024;
const MAX_TEXT = 60000;

function gitExe() {
  return vscode.workspace.getConfiguration("codedock").get("gitPath", "") || "git";
}

/** Run git with args (no shell). Resolves { code, out } - out is stdout+stderr. */
function runGit(repoDir, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      gitExe(),
      ["-c", "core.quotepath=false", "-C", repoDir, ...args],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, env: process.env },
      (err, stdout, stderr) => {
        if (err && err.code === "ENOENT") {
          reject(new Error("git executable not found. Install git or set codedock.gitPath."));
          return;
        }
        const out = `${stdout || ""}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
        if (err && err.killed) {
          reject(new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s\n${out.slice(-2000)}`));
          return;
        }
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out });
      }
    );
  });
}

/** Resolve the repository working directory (workspace-checked) and verify it is one. */
async function resolveRepo(explicit) {
  const dir = explicit ? scope.resolvePath(explicit) : scope.primaryRoot();
  if (!dir) throw new Error("No folder is open in this window.");
  const probe = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (probe.code !== 0) {
    throw new Error(`${scope.displayPath(dir)} is not inside a git repository.\n${probe.out.trim()}`);
  }
  const top = probe.out.trim().split(/\r?\n/)[0];
  // The repo root must itself stay inside the workspace: a folder deep inside
  // the workspace may belong to a repository rooted OUTSIDE it, and operating
  // on that repo would reach beyond the granted scope.
  if (!scope.inScope(top)) {
    throw new Error(`repository root ${top} lies outside the workspace scope.`);
  }
  return top;
}

function clip(text, max = MAX_TEXT) {
  const t = String(text || "");
  return t.length > max ? `${t.slice(0, max)}\n…（截断，共 ${t.length} 字符）` : t;
}

function fail(label, r) {
  return new Error(`${label} failed (exit ${r.code})\n${clip(r.out, 4000)}`);
}

/** Parse `status --porcelain=v2 --branch` into something readable. */
function parseStatus(out) {
  const branch = { head: "", upstream: "", ahead: 0, behind: 0 };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];

  for (const line of String(out).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) branch.head = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) branch.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]); }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const rename = line.startsWith("2 ");
      const pathPart = line.split("\t");
      const file = rename && pathPart.length > 1
        ? `${pathPart[1]} <- ${pathPart[0].split(" ").pop()}`
        : parts.slice(8).join(" ");
      if (xy[0] !== ".") staged.push(`${xy[0]}  ${file}`);
      if (xy[1] !== ".") unstaged.push(`${xy[1]}  ${file}`);
    } else if (line.startsWith("u ")) {
      conflicted.push(line.split(" ").slice(10).join(" ") || line.slice(2));
    } else if (line.startsWith("? ")) {
      untracked.push(line.slice(2));
    }
  }
  return { branch, staged, unstaged, untracked, conflicted };
}

const TOOLS = [
  {
    name: "git_status",
    title: "Git Status",
    description:
      "Current branch, ahead/behind counts, and every staged, unstaged, untracked and conflicted file. Start here before staging or committing.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const r = await runGit(repo, ["status", "--porcelain=v2", "--branch"]);
      if (r.code !== 0) throw fail("git status", r);
      const s = parseStatus(r.out);

      const lines = [
        `仓库：${scope.displayPath(repo)}`,
        `分支：${s.branch.head}${s.branch.upstream ? ` → ${s.branch.upstream}` : "（无上游）"}` +
          (s.branch.ahead || s.branch.behind ? `  [领先 ${s.branch.ahead} / 落后 ${s.branch.behind}]` : ""),
      ];
      const section = (title, items) => {
        if (items.length) lines.push("", `${title}（${items.length}）：`, ...items.map((i) => `  ${i}`));
      };
      section("冲突", s.conflicted);
      section("已暂存", s.staged);
      section("未暂存", s.unstaged);
      section("未跟踪", s.untracked);
      if (!s.conflicted.length && !s.staged.length && !s.unstaged.length && !s.untracked.length) {
        lines.push("", "工作区干净，没有任何改动。");
      }
      return {
        text: lines.join("\n"),
        meta: { staged: s.staged.length, unstaged: s.unstaged.length, untracked: s.untracked.length },
      };
    },
  },

  {
    name: "git_diff",
    title: "Git Diff",
    description:
      "Unified diff of the working tree. Default: unstaged changes. Pass staged=true for what would be committed, ref to diff against a commit/branch (e.g. HEAD~1, main), path to narrow to one file or folder.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        staged: { type: "boolean", description: "Diff the index (staged changes) instead of the working tree." },
        ref: { type: "string", description: "Diff against this commit/branch instead of the index." },
        path: { type: "string", description: "Limit the diff to this file or folder (workspace-relative)." },
        context_lines: { type: "number", description: "Context lines per hunk (default 3)." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const cmd = ["diff", "--no-color"];
      if (Number(args.context_lines) >= 0) cmd.push(`-U${Math.min(Number(args.context_lines), 100)}`);
      if (args.staged) cmd.push("--cached");
      if (args.ref) cmd.push(String(args.ref));
      if (args.path) cmd.push("--", scope.resolvePath(args.path));
      const r = await runGit(repo, cmd);
      if (r.code !== 0 && !r.out.trim()) throw fail("git diff", r);
      const body = r.out.trim();
      if (!body) return "没有差异。";
      const files = (body.match(/^diff --git /gm) || []).length;
      return { text: clip(body), meta: { files } };
    },
  },

  {
    name: "git_log",
    title: "Git Log",
    description:
      "Recent commit history: hash, author, date, subject. Narrow with path (history of one file), author, or grep (subject search).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        count: { type: "number", description: "How many commits (default 20, max 100)." },
        path: { type: "string", description: "Only commits touching this file or folder." },
        author: { type: "string", description: "Filter by author substring." },
        grep: { type: "string", description: "Filter by commit subject substring." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const count = Math.min(Number(args.count) || 20, 100);
      const cmd = ["log", `--max-count=${count}`, "--date=short", "--pretty=format:%h  %ad  %an  %s%d"];
      if (args.author) cmd.push(`--author=${String(args.author)}`);
      if (args.grep) cmd.push(`--grep=${String(args.grep)}`, "--regexp-ignore-case");
      if (args.path) cmd.push("--follow", "--", scope.resolvePath(args.path));
      const r = await runGit(repo, cmd);
      if (r.code !== 0) throw fail("git log", r);
      const body = r.out.trim();
      if (!body) return "没有匹配的提交。";
      const n = body.split("\n").length;
      return { text: clip(body), meta: { count: n } };
    },
  },

  {
    name: "git_show",
    title: "Git Show",
    description:
      "One commit in full: metadata, changed-file stat, and the patch itself. Use the hash from git_log.",
    inputSchema: {
      type: "object",
      required: ["ref"],
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        ref: { type: "string", description: "Commit hash / ref, e.g. a1b2c3d or HEAD~2." },
        stat_only: { type: "boolean", description: "Only the file list and stats, no patch body." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const ref = String(args.ref).trim();
      if (!/^[\w./~^@{}-]+$/.test(ref)) throw new Error(`ref contains characters that are not allowed: ${JSON.stringify(ref)}`);
      const cmd = ["show", "--no-color", ref];
      if (args.stat_only) cmd.splice(1, 0, "--stat");
      const r = await runGit(repo, cmd);
      if (r.code !== 0) throw fail("git show", r);
      return clip(r.out.trim());
    },
  },

  {
    name: "git_branch",
    title: "Git Branches",
    description: "List local (and optionally remote) branches with the current one marked.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        remotes: { type: "boolean", description: "Include remote-tracking branches." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const cmd = ["branch", "--no-color", "-vv"];
      if (args.remotes) cmd.push("--all");
      const r = await runGit(repo, cmd);
      if (r.code !== 0) throw fail("git branch", r);
      const body = r.out.trimEnd();
      const n = body ? body.split("\n").length : 0;
      return { text: body || "（没有分支 —— 空仓库？）", meta: { count: n } };
    },
  },

  {
    name: "git_stage",
    title: "Git Stage / Unstage",
    description:
      "Stage files for commit (git add), or with unstage=true move them back out of the index (git restore --staged - the working tree is never touched). Paths are workspace-relative; pass [\".\"] for everything.",
    inputSchema: {
      type: "object",
      required: ["paths"],
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        paths: { type: "array", items: { type: "string" }, description: "Files or folders to (un)stage." },
        unstage: { type: "boolean", description: "Remove from the index instead of adding." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const list = (Array.isArray(args.paths) ? args.paths : [args.paths]).map(String).filter(Boolean);
      if (!list.length) throw new Error("paths is empty.");
      const resolved = list.map((p) => (p === "." ? "." : scope.resolvePath(p)));
      const cmd = args.unstage ? ["restore", "--staged", "--", ...resolved] : ["add", "--", ...resolved];
      const r = await runGit(repo, cmd);
      if (r.code !== 0) throw fail(args.unstage ? "git restore --staged" : "git add", r);

      const st = await runGit(repo, ["status", "--porcelain=v2", "--branch"]);
      const s = parseStatus(st.out);
      return {
        text: `${args.unstage ? "已取消暂存" : "已暂存"} ${list.length} 个路径。当前暂存区：${s.staged.length} 个文件。`,
        meta: { staged: s.staged.length },
      };
    },
  },

  {
    name: "git_commit",
    title: "Git Commit",
    description:
      "Commit the staged changes. Refuses when nothing is staged (stage first with git_stage, or pass all=true to include every tracked modification). Never uses --no-verify: the project's hooks run.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        message: { type: "string", description: "Commit message. First line = subject." },
        all: { type: "boolean", description: "Also auto-stage every tracked, modified file (git commit -a)." },
        amend: { type: "boolean", description: "Amend the previous commit instead of creating a new one." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const message = String(args.message || "").trim();
      if (!message) throw new Error("commit message is required.");

      const cmd = ["commit", "-m", message];
      if (args.all) cmd.push("-a");
      if (args.amend) cmd.push("--amend");
      const r = await runGit(repo, cmd);
      if (r.code !== 0) throw fail("git commit", r);

      const head = await runGit(repo, ["log", "-1", "--pretty=format:%h  %s"]);
      return {
        text: `提交完成：${head.out.trim()}\n${clip(r.out.trim(), 2000)}`,
        meta: { commit: head.out.trim().split(" ")[0] },
      };
    },
  },

  {
    name: "git_checkout",
    title: "Git Checkout Branch",
    description:
      "Switch to a branch, or create it first with create=true. Only branch switching: this tool never discards working-tree changes (git itself refuses when they would be overwritten - commit or stage them first). File-restore forms of checkout are intentionally not exposed.",
    inputSchema: {
      type: "object",
      required: ["branch"],
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        branch: { type: "string", description: "Branch name." },
        create: { type: "boolean", description: "Create the branch (from the current HEAD) before switching." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const branch = String(args.branch || "").trim();
      if (!/^[\w][\w./-]*$/.test(branch) || branch.includes("..")) {
        throw new Error(`branch name contains characters that are not allowed: ${JSON.stringify(branch)}`);
      }
      const cmd = args.create ? ["switch", "-c", branch] : ["switch", branch];
      const r = await runGit(repo, cmd);
      if (r.code !== 0) throw fail("git switch", r);
      return `已切换到分支 ${branch}${args.create ? "（新建）" : ""}\n${clip(r.out.trim(), 2000)}`;
    },
  },

  {
    name: "git_push",
    title: "Git Push",
    description:
      "Push the current (or named) branch to a remote. Never forces: a rejected push is reported as-is, and history rewrites must go through run_command where the user is asked explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        remote: { type: "string", description: "Remote name (default origin)." },
        branch: { type: "string", description: "Branch to push (default: the current branch)." },
        set_upstream: { type: "boolean", description: "Pass -u to set the upstream on first push." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const remote = String(args.remote || "origin").trim();
      if (!/^[\w./-]+$/.test(remote)) throw new Error(`remote name not allowed: ${JSON.stringify(remote)}`);
      const cmd = ["push"];
      if (args.set_upstream) cmd.push("-u");
      cmd.push(remote);
      if (args.branch) {
        const branch = String(args.branch).trim();
        if (!/^[\w][\w./-]*$/.test(branch)) throw new Error(`branch name not allowed: ${JSON.stringify(branch)}`);
        cmd.push(branch);
      } else {
        // An explicit refspec, so the push works even before any upstream is
        // configured (push.default=simple refuses a bare `git push origin`).
        cmd.push("HEAD");
      }
      const r = await runGit(repo, cmd, { timeoutMs: 120000 });
      if (r.code !== 0) throw fail("git push", r);
      return `git push 完成\n${clip(r.out.trim(), 4000) || "(no output)"}`;
    },
  },

  {
    name: "git_pull",
    title: "Git Pull",
    description:
      "Fetch and integrate from the upstream. Fast-forward only by default, so it can never create a surprise merge commit or conflict state; pass rebase=true to rebase local commits on top instead.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository folder (defaults to the workspace root)." },
        rebase: { type: "boolean", description: "Rebase instead of fast-forward-only." },
      },
    },
    async run(args) {
      const repo = await resolveRepo(args.repo);
      const cmd = ["pull", args.rebase ? "--rebase" : "--ff-only"];
      const r = await runGit(repo, cmd, { timeoutMs: 120000 });
      if (r.code !== 0) throw fail("git pull", r);
      return `git pull 完成\n${clip(r.out.trim(), 4000) || "(no output)"}`;
    },
  },
];

module.exports = { TOOLS, parseStatus, runGit, resolveRepo };
