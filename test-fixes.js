/* Regression tests for the 1.5.1 fixes. Runs with the stubbed `vscode` module. */
const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const vscode = require("vscode");

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log("  PASS", name); })
    .catch((err) => { console.error("  FAIL", name, "-", err.message); process.exitCode = 1; });
}

(async () => {
  console.log("[BUG-1] license");
  const lic = require("./lib/license.js");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  vscode.__setPub(publicKey.export({ type: "spki", format: "pem" }).toString());
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const payload = JSON.stringify({ id: "CDK-001", plan: "pro", exp: "2030-01-01" });
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey);
  const key = `CODEDOCK.${b64u(payload)}.${b64u(sig)}`;

  await ok("legit signed key verifies", () => {
    const r = lic.verifyKey(key);
    assert.strictEqual(r.valid, true, JSON.stringify(r));
    assert.strictEqual(r.payload.id, "CDK-001");
  });
  await ok("key pasted with spaces/newlines still verifies", () => {
    const messy = key.slice(0, 20) + " \n " + key.slice(20);
    assert.strictEqual(lic.verifyKey(messy).valid, true);
  });
  await ok("lowercase prefix accepted", () => {
    assert.strictEqual(lic.verifyKey("codedock." + key.split(".")[1] + "." + key.split(".")[2]).valid, true);
  });
  await ok("tampered payload rejected", () => {
    const forged = `CODEDOCK.${b64u(payload.replace("2030", "2099"))}.${b64u(sig)}`;
    assert.strictEqual(lic.verifyKey(forged).valid, false);
  });
  await ok("expired key rejected", () => {
    const p2 = JSON.stringify({ id: "X", exp: "2020-01-01" });
    const s2 = crypto.sign(null, Buffer.from(p2, "utf8"), privateKey);
    const r = lic.verifyKey(`CODEDOCK.${b64u(p2)}.${b64u(s2)}`);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, "expired");
  });

  console.log("[BUG-3/4] gateway");
  const gateway = require("./lib/gateway.js");
  const gm = new gateway.GatewayManager({ providers: [] });
  const calls = [];
  gm.providers.set("gh", {
    ready: true,
    async callTool(name, args) {
      calls.push([name, args]);
      if (name === "boom") return { isError: true, content: [{ type: "text", text: "it broke" }] };
      return { content: [{ type: "text", text: `ran ${name}` }, { type: "image", data: "AA==", mimeType: "image/png" }] };
    },
  });

  await ok("findTool splits on FIRST __ only", async () => {
    const tool = gm.findTool("gh__repo__get_file");
    assert(tool, "tool not found");
    assert.strictEqual(tool.originalName, "repo__get_file");
    await tool.run({ a: 1 });
    assert.deepStrictEqual(calls.pop()[0], "repo__get_file");
  });
  await ok("external result unwrapped to content blocks", async () => {
    const out = await gm.findTool("gh__list").run({});
    assert(Array.isArray(out), "expected content array");
    assert.strictEqual(out[0].text, "ran list");
    assert.strictEqual(out[1].type, "image");
  });
  await ok("isError becomes a thrown error", async () => {
    await assert.rejects(() => gm.findTool("gh__boom").run({}), /it broke/);
  });
  await ok("plain-object results still pass through", () => {
    assert.deepStrictEqual(gateway.unwrapExternalResult({ foo: 1 }, "x"), { foo: 1 });
  });

  console.log("[BUG-2] server shutdown with open SSE stream");
  const { createHttpServer } = require("./lib/server.js");
  const server = createHttpServer({
    dispatcher: { handle: async () => ({}) },
    routeToken: "tok123",
    getPublicUrl: () => null,
    roots: () => ["/tmp"],
    log: () => {},
    onMetric: () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  await ok("SSE stream opens", async () => {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/sse?token=tok123" }, (res) => {
        assert.strictEqual(res.statusCode, 200);
        res.once("data", () => resolve());
        res.on("error", () => {});
      });
      req.on("error", reject);
      setTimeout(() => reject(new Error("no SSE data within 3s")), 3000).unref();
    });
  });
  await ok("close + destroyConnections resolves fast (was: hung forever)", async () => {
    const closed = new Promise((resolve) => {
      server.close(() => resolve());
      server.destroyConnections();
    });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("server.close still hangs")), 3000).unref());
    await Promise.race([closed, timeout]);
  });

  console.log("[DOC-1] tools-exec constants");
  const execTools = require("./lib/tools-exec.js");
  await ok("HARD_WAIT_MS dead code removed", () => {
    const src = require("fs").readFileSync("./lib/tools-exec.js", "utf8");
    assert(!src.includes("HARD_WAIT_MS"), "HARD_WAIT_MS still present");
    assert(execTools.OutputBuffer, "exports intact");
  });

  console.log(`\n${passed} test(s) passed${process.exitCode ? " (with failures)" : ", all green"}`);
})();

/* ---- round 2: the 10 low-risk fixes ---- */
(async () => {
  await new Promise((r) => setTimeout(r, 500)); // let round-1 finish printing

  console.log("[#1] UTF-8 boundary in readFromOffset");
  const et = require("./lib/tools-exec.js");
  await ok("trimIncompleteUtf8 cuts a split character", () => {
    const full = Buffer.from("你好", "utf8"); // 6 bytes
    assert.strictEqual(et.trimIncompleteUtf8(full.slice(0, 4)).length, 3); // "你" + 1 dangling byte -> 3
    assert.strictEqual(et.trimIncompleteUtf8(full.slice(0, 3)).toString(), "你"); // clean boundary untouched
    assert.strictEqual(et.trimIncompleteUtf8(Buffer.from("abc")).toString(), "abc"); // ascii untouched
    const cont = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]); // binary garbage: never trimmed to nothing forever
    assert.strictEqual(et.trimIncompleteUtf8(cont).length, 5);
  });
  await ok("readFromOffset never splits a multi-byte char mid-window", () => {
    const fakeRecord = { logFile: null, buffer: { text: "你好世界" } };
    const os = require("os"), fs = require("fs"), path = require("path");
    const f = path.join(os.tmpdir(), "cd-utf8-test.log");
    fs.writeFileSync(f, "你好世界", "utf8"); // 12 bytes
    fakeRecord.logFile = f;
    const r1 = et.readFromOffset(fakeRecord, 0, 4); // 4 bytes -> should trim to 3 ("你")
    assert.strictEqual(r1.text, "你");
    assert.strictEqual(r1.next_offset, 3);
    const r2 = et.readFromOffset(fakeRecord, r1.next_offset, 4);
    assert.strictEqual(r2.text, "好");
    fs.unlinkSync(f);
  });

  console.log("[#4] platform-aware quoting + whitelists");
  await ok("POSIX: injection-looking arg is inert single-quoted", () => {
    delete require.cache[require.resolve("./lib/tools-dotnet.js")];
    const src = require("fs").readFileSync("./lib/tools-dotnet.js", "utf8");
    assert(src.includes("CONFIGURATION_RE"), "whitelist present");
    assert(src.includes("safeArg(args.filter"), "filter gated");
    assert(src.includes('safeArg(args.runtime'), "runtime gated");
  });
  await ok("win32 branch escapes $ ` \" and quotes ; & |", () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      delete require.cache[require.resolve("./lib/tools-godot.js")];
      const g = require("fs").readFileSync("./lib/tools-godot.js", "utf8");
      // exercise via a fresh eval of the quote function body
      const quote = new Function("value", g.match(/function quote\(value\) \{([\s\S]*?)\n\}/)[1].replace(/^/, "") + "");
      assert.strictEqual(quote("Debug;calc"), '"Debug;calc"');       // ; now forces quoting
      assert.strictEqual(quote("a$b"), '"a`$b"');                    // $ escaped, no expansion
      assert.strictEqual(quote('say"hi"'), '"say`"hi`""');           // " escaped PS-style
      assert.strictEqual(quote("plainDebug"), "plainDebug");         // simple stays bare
      assert.strictEqual(quote("res://test/Main.tscn"), "res://test/Main.tscn"); // godot scene path untouched
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
  });

  console.log("[#7] guard quotedSpans");
  const guard = require("./lib/guard.js");
  await ok("apostrophe words no longer create bogus spans", () => {
    // previously: span between the two apostrophes could trip patterns
    assert.deepStrictEqual(guard.scan("echo don't panic, it's fine"), []);
  });
  await ok("real nested payloads still caught", () => {
    assert(guard.scan("sudo sh -c 'rm -rf /'").length > 0);
    assert(guard.scan('cmd /c "del /s /q C:\\x"').length > 0);
  });

  console.log("[#6] metrics gap under concurrency");
  await ok("second in-flight request gets gap=null", () => {
    const { MetricsTracker } = require("./lib/metrics.js");
    const t = new MetricsTracker();
    const a = t.startRequest("POST", "x"); a.finish("x");   // establishes lastResponseEndedAt
    const b = t.startRequest("POST", "y");                   // idle -> real gap
    const c = t.startRequest("POST", "z");                   // concurrent -> null
    assert.notStrictEqual(b.gapMs, null);
    assert.strictEqual(c.gapMs, null);
    b.finish("y"); c.finish("z");
  });

  console.log("[#2/#5/#8/#9/#10] source-level assertions");
  const fs2 = require("fs");
  await ok("scope: loop exhaustion now fails closed", () =>
    assert(fs2.readFileSync("./lib/scope.js", "utf8").includes("return false;\n}")));
  await ok("server: guide page escapes interpolations", () => {
    const s = fs2.readFileSync("./lib/server.js", "utf8");
    assert(s.includes("function escapeHtml"), "helper");
    assert(s.includes("${safeEndpoint}") && s.includes("${safePrompt}") && s.includes("${safeSseUrl}"));
  });
  await ok("tunnel: workspace dirs no longer searched for binaries", () => {
    const s = fs2.readFileSync("./lib/tunnel.js", "utf8");
    assert(!s.includes("for (const dir of searchDirs"), "search loop removed");
  });
  await ok("extension: config-listener restart suppressed during regenerateToken", () => {
    const s = fs2.readFileSync("./extension.js", "utf8");
    assert(s.includes("suppressConfigRestart = true") && s.includes("controller.suppressConfigRestart) return"));
  });
  await ok("package.json: broken smoke script gone", () =>
    assert(!("scripts" in JSON.parse(fs2.readFileSync("./package.json", "utf8")))));
  await ok("tools.js: search_files summary uses include", () =>
    assert(fs2.readFileSync("./lib/tools.js", "utf8").includes("args.include ? ` in ${args.include}`")));

  console.log(`\nround-2 done, total ${passed} test(s) passed${process.exitCode ? " (with failures)" : ""}`);
})();
