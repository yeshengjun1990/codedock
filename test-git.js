/* End-to-end test of the git toolchain against a real repository. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const vscode = require("vscode");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cd-git-"));
const REPO = path.join(WORK, "repo");
const REMOTE = path.join(WORK, "remote.git");
fs.mkdirSync(REPO);

const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

// repo with an initial commit + a bare remote
execFileSync("git", ["init", "-b", "main", REPO]);
sh(REPO, "config", "user.email", "t@t.dev");
sh(REPO, "config", "user.name", "tester");
fs.writeFileSync(path.join(REPO, "a.txt"), "hello\n");
sh(REPO, "add", ".");
sh(REPO, "commit", "-m", "init");
execFileSync("git", ["init", "--bare", REMOTE]);
sh(REPO, "remote", "add", "origin", REMOTE);

// point the vscode stub's workspace at the repo
vscode.__setFolders([{ uri: { fsPath: REPO } }]);

const git = require("./lib/tools-git.js");
const byName = Object.fromEntries(git.TOOLS.map((t) => [t.name, t]));
const text = (r) => (typeof r === "string" ? r : r.text);

let passed = 0;
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log("  PASS", name); }
  catch (e) { console.error("  FAIL", name, "-", e.message); process.exitCode = 1; }
};

(async () => {
  await ok("git_status: clean tree", async () => {
    const r = await byName.git_status.run({});
    assert(text(r).includes("main"));
    assert(text(r).includes("工作区干净"));
  });

  fs.writeFileSync(path.join(REPO, "a.txt"), "hello\nworld 世界\n");
  fs.writeFileSync(path.join(REPO, "b.txt"), "new\n");

  await ok("git_status: sees unstaged + untracked", async () => {
    const r = await byName.git_status.run({});
    assert(text(r).includes("未暂存") && text(r).includes("a.txt"));
    assert(text(r).includes("未跟踪") && text(r).includes("b.txt"));
  });

  await ok("git_diff: shows the change incl. CJK", async () => {
    const r = await byName.git_diff.run({});
    assert(text(r).includes("+world 世界"));
  });

  await ok("git_stage: stages everything", async () => {
    const r = await byName.git_stage.run({ paths: ["."] });
    assert(r.meta.staged === 2, `staged=${r.meta.staged}`);
  });

  await ok("git_stage unstage: index only, tree untouched", async () => {
    await byName.git_stage.run({ paths: ["b.txt"], unstage: true });
    const st = await byName.git_status.run({});
    assert(text(st).includes("未跟踪") && text(st).includes("b.txt"));
    assert(fs.existsSync(path.join(REPO, "b.txt")));
    await byName.git_stage.run({ paths: ["b.txt"] }); // re-stage for commit
  });

  await ok("git_commit: commits staged work", async () => {
    const r = await byName.git_commit.run({ message: "feat: add world + b" });
    assert(/提交完成：[0-9a-f]{7}/.test(text(r)));
  });

  await ok("git_log: two commits, grep works", async () => {
    const all = await byName.git_log.run({});
    assert(all.meta.count === 2);
    const hit = await byName.git_log.run({ grep: "world" });
    assert(hit.meta.count === 1);
  });

  await ok("git_show: patch of HEAD", async () => {
    const r = await byName.git_show.run({ ref: "HEAD" });
    assert(text(r).includes("feat: add world") && text(r).includes("+world 世界"));
  });
  await ok("git_show: hostile ref rejected", () =>
    assert.rejects(() => byName.git_show.run({ ref: "HEAD; rm -rf /" }), /not allowed/));

  await ok("git_checkout: create + switch, bad names rejected", async () => {
    const r = await byName.git_checkout.run({ branch: "feature/x", create: true });
    assert(text(r).includes("feature/x"));
    await assert.rejects(() => byName.git_checkout.run({ branch: "-delete-everything" }), /not allowed/);
    await byName.git_checkout.run({ branch: "main" });
  });

  await ok("git_branch: lists both", async () => {
    const r = await byName.git_branch.run({});
    assert(text(r).includes("feature/x") && text(r).includes("main"));
  });

  await ok("git_push: first push with -u", async () => {
    const r = await byName.git_push.run({ set_upstream: true });
    assert(text(r).includes("git push 完成"));
    assert(sh(REMOTE, "log", "--oneline", "main").split("\n").filter(Boolean).length >= 2);
  });

  await ok("git_pull: ff-only on up-to-date", async () => {
    const r = await byName.git_pull.run({});
    assert(text(r).includes("git pull 完成"));
  });

  await ok("repo outside workspace scope is refused", async () => {
    vscode.__setFolders([{ uri: { fsPath: path.join(REPO, "sub") } }]);
    fs.mkdirSync(path.join(REPO, "sub"), { recursive: true });
    // workspace = repo/sub, but the repo root is repo -> outside scope
    await assert.rejects(() => byName.git_status.run({}), /outside the workspace scope/);
    vscode.__setFolders([{ uri: { fsPath: REPO } }]);
  });

  await ok("non-repo folder gives a clear error", async () => {
    const bare = path.join(WORK, "plain");
    fs.mkdirSync(bare);
    vscode.__setFolders([{ uri: { fsPath: bare } }]);
    await assert.rejects(() => byName.git_status.run({}), /not inside a git repository/);
    vscode.__setFolders([{ uri: { fsPath: REPO } }]);
  });

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${passed} git test(s) passed${process.exitCode ? " (with failures)" : ", all green"}`);
})();
