/* Tests for the out-of-scope approval flow (codedock.extraRoots). */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cd-scope-"));
const INSIDE = path.join(WORK, "ws");
const OUTSIDE = path.join(WORK, "elsewhere");
fs.mkdirSync(INSIDE);
fs.mkdirSync(OUTSIDE);
fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "outside\n");

vscode.__setFolders([{ uri: { fsPath: INSIDE } }]);
const scope = require("./lib/scope.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log("  PASS", name); }
  catch (e) { console.error("  FAIL", name, "-", e.message); process.exitCode = 1; }
};

(async () => {
  await ok("inside path resolves as before", async () => {
    assert.strictEqual(scope.resolvePath("a.txt"), path.join(INSIDE, "a.txt"));
  });

  await ok("outside path: rejected + prompt fired with retry hint", async () => {
    vscode.__setWarningHandler(() => undefined); // user ignores the dialog
    assert.throws(() => scope.resolvePath(path.join(OUTSIDE, "secret.txt")),
      /outside the workspace[\s\S]*授权请求[\s\S]*本次会话允许/);
    assert.strictEqual(vscode.__warnings.length, 1);
    assert(vscode.__warnings[0].buttons.includes("本次会话允许"));
    assert(!vscode.__warnings[0].buttons.includes("永久允许"), "永久允许 button must be gone");
    assert(vscode.__warnings[0].message.includes(OUTSIDE)); // offers the directory, not the file
  });

  await ok("dismissing the dialog approves nothing", async () => {
    await wait(20);
    assert.deepStrictEqual(vscode.__config.extraRoots || [], []);
    assert.throws(() => scope.resolvePath(path.join(OUTSIDE, "secret.txt")), /outside the workspace/);
  });

  await ok("duplicate prompts are collapsed while one is pending", async () => {
    await wait(20); // let the previous test's dialog fully settle first
    let release;
    vscode.__setWarningHandler(() => new Promise((r) => { release = r; }));
    const before = vscode.__warnings.length;
    assert.throws(() => scope.resolvePath(path.join(OUTSIDE, "a.txt")));
    assert.throws(() => scope.resolvePath(path.join(OUTSIDE, "b.txt")));
    assert.throws(() => scope.resolvePath(path.join(OUTSIDE, "c.txt")));
    assert.strictEqual(vscode.__warnings.length, before + 1, "only one dialog for the same directory");
    release(undefined);
    await wait(20);
  });

  await ok("session approval: works now, not written to settings", async () => {
    const sess = path.join(WORK, "session-dir");
    fs.mkdirSync(sess);
    vscode.__setWarningHandler(() => "本次会话允许");
    assert.throws(() => scope.resolvePath(path.join(sess, "f.txt")));
    await wait(20);
    assert.strictEqual(scope.resolvePath(path.join(sess, "f.txt")), path.join(sess, "f.txt"));
    assert(!(vscode.__config.extraRoots || []).includes(sess), "session grant must not touch settings");
  });

  await ok("session approval is gone after a 'restart' (fresh module)", async () => {
    const sess = path.join(WORK, "session-dir");
    delete require.cache[require.resolve("./lib/scope.js")];
    const scope2 = require("./lib/scope.js");
    vscode.__setWarningHandler(() => undefined);
    assert.throws(() => scope2.resolvePath(path.join(sess, "f.txt")), /outside the workspace/);
    await wait(20);
  });

  await ok("manual extraRoots entry still honored", async () => {
    vscode.__config.extraRoots = [OUTSIDE];
    // retry passes, and so does everything under the tree
    assert.strictEqual(scope.resolvePath(path.join(OUTSIDE, "secret.txt")), path.join(OUTSIDE, "secret.txt"));
    assert.strictEqual(scope.resolvePath(path.join(OUTSIDE, "deep", "new.txt")), path.join(OUTSIDE, "deep", "new.txt"));
    assert(scope.inScope(OUTSIDE));
  });

  await ok("approval does not leak to siblings", async () => {
    const sibling = path.join(WORK, "other");
    fs.mkdirSync(sibling);
    vscode.__setWarningHandler(() => undefined);
    assert.throws(() => scope.resolvePath(path.join(sibling, "x.txt")), /outside the workspace/);
    await wait(20);
  });

  await ok("relative / junk entries in extraRoots are ignored", async () => {
    vscode.__config.extraRoots = [OUTSIDE, "relative/dir", 42, "  "];
    const r = scope.roots();
    assert(r.includes(INSIDE) && r.includes(OUTSIDE));
    assert(!r.some((x) => String(x).includes("relative") || x === 42 || String(x).trim() === ""));
  });


  await ok("allowOutsideWorkspace=true: everything passes, no prompt", async () => {
    const anywhere = path.join(WORK, "totally-unrelated");
    fs.mkdirSync(anywhere);
    vscode.__config.allowOutsideWorkspace = true;
    const before = vscode.__warnings.length;
    assert.strictEqual(scope.resolvePath(path.join(anywhere, "x.txt")), path.join(anywhere, "x.txt"));
    assert(scope.inScope("/"));
    assert.strictEqual(vscode.__warnings.length, before, "no dialog when the master switch is on");
  });

  await ok("switch off again: boundary is back", async () => {
    vscode.__config.allowOutsideWorkspace = false;
    vscode.__setWarningHandler(() => undefined);
    assert.throws(() => scope.resolvePath(path.join(WORK, "totally-unrelated", "x.txt")), /outside the workspace/);
    await wait(20);
  });

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${passed} extraRoots test(s) passed${process.exitCode ? " (with failures)" : ", all green"}`);
})();
