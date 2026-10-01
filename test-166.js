/* Verification for the 1.6.6 changes. Runs with the stubbed `vscode` module.
 * Covers: credential guard (isSensitiveFile matrix, read_files batch behaviour,
 * search exclusion, per-file session grant), the replay/single-flight layer for
 * state-changing tools (denials never cached, read tools never replayed), and
 * the clientInfo registry fed by MCP initialize. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const scope = require("./lib/scope");
const tools = require("./lib/tools");
const guard = require("./lib/guard");
const { createDispatcher, recentClients, buildInstructions } = require("./lib/protocol");

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "codedock166-"));
const events = [];
tools.setObserver((e) => events.push(e));

fs.mkdirSync(path.join(WS, "src"), { recursive: true });
fs.mkdirSync(path.join(WS, ".aws"), { recursive: true });
fs.writeFileSync(path.join(WS, ".env"), "API_SECRET=hunter2\n");
fs.writeFileSync(path.join(WS, ".env.example"), "API_SECRET=\n");
fs.writeFileSync(path.join(WS, "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
fs.writeFileSync(path.join(WS, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
fs.writeFileSync(path.join(WS, ".npmrc"), "//registry.npmjs.org/:_authToken=t0k3n\n");
fs.writeFileSync(path.join(WS, ".aws", "credentials"), "[default]\naws_access_key_id = AKIA...\n");
fs.writeFileSync(path.join(WS, "src", "main.js"), "console.log('hello from main');\n");

vscode.__setFolders([{ uri: { fsPath: WS } }]);

let passed = 0;
function ok(label, cond) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------- 1. matrix
console.log("1. isSensitiveFile matrix");
ok(".env", scope.isSensitiveFile(path.join(WS, ".env")));
ok(".env.local", scope.isSensitiveFile(path.join(WS, "config", ".env.local")));
ok("server.pem", scope.isSensitiveFile(path.join(WS, "server.pem")));
ok("id_rsa", scope.isSensitiveFile(path.join(WS, "id_rsa")));
ok(".npmrc", scope.isSensitiveFile(path.join(WS, ".npmrc")));
ok(".aws/credentials", scope.isSensitiveFile(path.join(WS, ".aws", "credentials")));
ok(".env.example is safe", !scope.isSensitiveFile(path.join(WS, ".env.example")));
ok("src/main.js is safe", !scope.isSensitiveFile(path.join(WS, "src", "main.js")));
ok("master switch disables the list", (() => {
  vscode.__config["allowSecretFiles"] = true;
  const r = scope.isSensitiveFile(path.join(WS, ".env"));
  vscode.__config["allowSecretFiles"] = false;
  return r === false;
})());

(async () => {
  // ------------------------------------------------------ 2. read_files guard
  console.log("2. read_files credential guard");
  {
    const before = vscode.__warnings.length;
    const result = await tools.callTool("read_files", { paths: [".env", ".env.example", "src/main.js"] });
    const text = result.content.map((p) => p.text).join("\n");
    ok(".env refused", text.includes(".env") && text.includes("[credential guard]"));
    ok("batch survives: .env.example content returned", text.includes("API_SECRET=") && text.includes(".env.example"));
    ok("batch survives: main.js content returned", text.includes("hello from main"));
    ok("modal prompt fired", vscode.__warnings.length === before + 1);
    ok("prompt mentions the file", vscode.__warnings[before].message.includes(".env"));
  }

  // ---------------------------------------------------- 3. search_files guard
  console.log("3. search_files silent exclusion");
  {
    vscode.__setFindFiles([
      vscode.Uri.file(path.join(WS, ".env")),
      vscode.Uri.file(path.join(WS, "server.pem")),
      vscode.Uri.file(path.join(WS, "src", "main.js")),
    ]);
    const secret = await tools.callTool("search_files", { query: "hunter2" });
    const secretText = secret.content[0].text;
    ok("secret content not found", secretText.includes("no matches"));
    ok(".env not even named", !secretText.includes(".env"));
    const plain = await tools.callTool("search_files", { query: "hello from main" });
    ok("normal files still searchable", plain.content[0].text.includes("src/main.js:1"));
  }

  // ------------------------------------------------- 4. per-file session grant
  console.log("4. per-file session approval");
  {
    scope.approveSecretForSession(path.join(WS, ".env"));
    const result = await tools.callTool("read_files", { paths: [".env"] });
    ok("approved file reads", result.content[0].text.includes("hunter2"));
    const pem = await tools.callTool("read_files", { paths: ["server.pem"] });
    ok("other secrets still refused", pem.content[0].text.includes("[credential guard]"));
  }

  // --------------------------------------------------------- 5. replay layer
  console.log("5. replay layer");
  {
    vscode.__config["permission.execute"] = true;
    const first = await tools.callTool("run_command", { command: 'node -p "Date.now()"' });
    const firstText = first.content[0].text.trim();
    const second = await tools.callTool("run_command", { command: 'node -p "Date.now()"' });
    const secondText = second.content.find((p) => p.type === "text").text;
    ok("replay returns the recorded output", secondText.includes(firstText));
    ok("replay is labelled", second.content.some((p) => p.text.includes("[replayed]")));
    ok("replay badge in activity", events.some((e) => e.phase === "end" && e.replayed === true));

    const readEventsBefore = events.length;
    await tools.callTool("list_directory", { path: WS });
    await tools.callTool("list_directory", { path: WS });
    const readEvents = events.slice(readEventsBefore).filter((e) => e.phase === "end");
    ok("read tools never replay", readEvents.length === 2 && readEvents.every((e) => e.replayed !== true));
  }

  // --------------------------------------------------- 6. denial not cached
  console.log("6. denial is not cached");
  {
    const deniedCommand = "echo denial-probe-marker";
    vscode.__config["permission.execute"] = false;
    await assert.rejects(
      () => tools.callTool("run_command", { command: deniedCommand }),
      /permission denied/,
      "denied while execute is off"
    );
    vscode.__config["permission.execute"] = true;
    const result = await tools.callTool("run_command", { command: deniedCommand });
    const text = result.content[0].text;
    ok("same args execute after the switch flips", text.includes("denial-probe-marker") && !text.includes("[replayed]"));
    ok("denial surfaced as blocked call", events.some((e) => e.phase === "end" && e.denied === true));
  }

  // --------------------------------------------------- 7. clientInfo registry
  console.log("7. clientInfo registry");
  {
    const logs = [];
    const dispatcher = createDispatcher({ roots: () => [WS], extraInstructions: () => "", log: (m) => logs.push(m) });
    await dispatcher.handle({ method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "ChatGPT", version: "2.1" } } });
    await dispatcher.handle({ method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "Devin" } } });
    await dispatcher.handle({ method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "ChatGPT", version: "2.1" } } });
    const list = recentClients();
    ok("two distinct clients", list.length === 2);
    ok("names captured", list.some((c) => c.name === "ChatGPT") && list.some((c) => c.name === "Devin"));
    const hello = logs.filter((m) => m.includes("客户端接入"));
    ok("first handshake logged once per client", hello.length === 2);
    await dispatcher.handle({ method: "initialize", params: {} });
    ok("missing clientInfo ignored", recentClients().length === 2);
    ok("instructions mention credential guard", buildInstructions({ roots: [WS], extra: "" }).includes("Credential material"));
  }

  // ------------------------------------- 8. guard: paired samples (1.6.7)
  // Every guard regression in the 1.6.7 audit is locked here as a pair:
  // a dangerous form that MUST hit, and a lookalike that MUST pass.
  console.log("8. guard paired samples");
  {
    const HIT_RM = "递归或强制删除（rm -rf）";
    const HIT_PUSH = "强制推送（git push --force）";
    const mustHit = [
      ["rm -rf build", HIT_RM],
      ["sudo rm --recursive --force x", HIT_RM],
      ["rm build -rf", HIT_RM],
      ['sh -c "rm -rf /"', HIT_RM],
      ['rm "a (1).txt" -rf', HIT_RM],
      ["git push --force", HIT_PUSH],
      ["git push -f origin main", HIT_PUSH],
      ["git push origin +main:main", HIT_PUSH],
      ["git push origin +main", HIT_PUSH],
      ["git push --force-with-lease origin main --force", HIT_PUSH],
    ];
    const mustPass = [
      "rm note.txt",
      "rm note.txt && ls -r src",
      "rm tmp.txt; grep -r foo src",
      "git push origin main",
      "git push --force-with-lease origin main",
      "git push origin feature+x",
    ];
    for (const [cmd, label] of mustHit) {
      ok(`guard hits: ${cmd}`, guard.scan(cmd).includes(label), guard.scan(cmd).join(",") || "no hit");
    }
    for (const cmd of mustPass) {
      ok(`guard passes: ${cmd}`, !guard.scan(cmd).length, guard.scan(cmd).join(","));
    }
  }

  console.log(`\nAll ${passed} checks passed.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
