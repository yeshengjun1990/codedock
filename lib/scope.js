/**
 * Workspace scope.
 *
 * The exposure boundary is exactly "the folders open in this window" - the same
 * rule the editor itself uses. Every path a tool touches is resolved and checked
 * against these roots before anything is read or written, so a remote client can
 * never climb out of the workspace with ../ tricks or an absolute path.
 *
 * The lexical check alone is not enough: a symlink or junction INSIDE the
 * workspace can point out of it (a cloned repository can carry one), and the
 * OS follows links when the file is read. So the check is repeated on the
 * real path of the nearest existing ancestor of the target.
 */

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

/**
 * User-approved directories outside the workspace (codedock.extraRoots).
 *
 * Populated when the user clicks 允许 on the out-of-scope prompt below, or by
 * editing the setting directly. Only absolute paths count - a relative entry
 * would silently anchor somewhere surprising, so it is ignored.
 */
function extraRoots() {
  try {
    const list = vscode.workspace.getConfiguration("codedock").get("extraRoots", []);
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => typeof p === "string" && p.trim() && path.isAbsolute(p.trim()))
      .map((p) => path.resolve(p.trim()));
  } catch {
    return [];
  }
}

/**
 * Directories approved for THIS session only ("本次会话允许" on the prompt).
 *
 * Deliberately just module state: a window reload or VS Code restart starts
 * a fresh session and the user is asked again. Permanent grants go through
 * codedock.extraRoots instead.
 */
const sessionRoots = new Set();

function roots() {
  return [
    ...(vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath),
    ...extraRoots(),
    ...sessionRoots,
  ];
}

function primaryRoot() {
  const list = roots();
  return list.length ? list[0] : null;
}

function isInside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Master switch: codedock.allowOutsideWorkspace.
 *
 * True means every path on this machine is in scope and no approval prompt
 * is ever shown. This is the user saying "I trust this tunnel with the whole
 * disk" - it must be flipped by hand in settings and defaults to off.
 */
function allowAll() {
  try {
    return vscode.workspace.getConfiguration("codedock").get("allowOutsideWorkspace", false) === true;
  } catch {
    return false;
  }
}

function inScope(fsPath) {
  if (allowAll()) return true;
  const resolved = path.resolve(fsPath);
  return roots().some((root) => isInside(resolved, path.resolve(root)));
}

/**
 * Re-run the scope check against reality, not the caller's spelling.
 *
 * Walks up from the target to the nearest existing ancestor (the target itself
 * may not exist yet - apply_patch creates files), realpaths that, and checks
 * both the ancestor and the rejoined tail. If even the drive root cannot be
 * realpathed, give up and let the lexical result stand.
 */
function realInScope(resolved) {
  let probe = resolved;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    let real;
    try {
      real = fs.realpathSync(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return true;
      tail.unshift(path.basename(probe));
      probe = parent;
      continue;
    }
    return inScope(real) && inScope(path.join(real, ...tail));
  }
  // More than 64 non-existent ancestors is not a path shape any legitimate
  // call produces - refuse rather than fall open on the boundary check.
  return false;
}

/**
 * Resolve a caller-supplied path.
 *
 * Relative paths are anchored at the first workspace folder, which is what a
 * model means by "src/app.js" when it has been told the project root.
 */
function resolvePath(input) {
  if (!input || typeof input !== "string") {
    throw new Error("path is required");
  }
  const list = roots();
  if (!list.length) {
    throw new Error("No folder is open in this window. Open a folder before using the Bridge.");
  }
  const base = path.resolve(list[0]);
  const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(base, input);
  if (!inScope(resolved)) {
    const dir = promptForAccess(resolved);
    throw new Error(
      `Path is outside the workspace: ${resolved}\n` +
        `已在 VS Code 中弹出授权请求（目录：${dir}）。` +
        `用户点击「本次会话允许」后重试本次调用即可（授权在重启后失效）。\n` +
        `Allowed roots:\n${roots().map((r) => `  - ${r}`).join("\n")}`
    );
  }
  if (!realInScope(resolved)) {
    throw new Error(
      `Path leaves the workspace through a symlink or junction: ${resolved}\nAllowed roots:\n${list
        .map((r) => `  - ${r}`)
        .join("\n")}`
    );
  }
  return resolved;
}

/**
 * Out-of-scope access prompt.
 *
 * The remote call that tripped the boundary has already failed by the time
 * the user sees this dialog - resolvePath is synchronous and must not block
 * on a human. So the flow is: fire the prompt, fail the call with a message
 * telling the caller to retry, and if the user approves, write the directory
 * into codedock.extraRoots (global settings) so the retry - and every later
 * call - passes. Escape / closing the dialog approves nothing, same
 * asymmetry as guard.confirm.
 *
 * One live prompt per directory: a burst of calls against the same tree must
 * not stack ten identical dialogs.
 */
const pendingPrompts = new Map();

function promptForAccess(resolved) {
  let dir;
  try {
    dir = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    dir = path.dirname(resolved);
  }
  if (pendingPrompts.has(dir)) return dir;

  const done = Promise.resolve(
    vscode.window.showWarningMessage(
      `远程 AI 请求访问工作区之外的路径\n\n${resolved}\n\n允许本次会话访问这个目录（含子目录）吗？\n${dir}\n\n重启 VS Code 后失效，下次会重新询问。如需长期放开全部路径，可在 CodeDock 面板的「访问权限控制」里开启总开关。`,
      { modal: true },
      "本次会话允许",
      "拒绝"
    )
  )
    .then((answer) => {
      if (answer === "本次会话允许") sessionRoots.add(dir);
    })
    .catch(() => {})
    .then(() => pendingPrompts.delete(dir));
  pendingPrompts.set(dir, done);
  return dir;
}

/**
 * Credential material that must not leave the machine through a read tool.
 *
 * The workspace boundary decides WHERE a path may live; this list decides what
 * may LEAVE. A repository routinely carries secrets its author never meant to
 * publish - .env, private keys, registry tokens - and Read permission would
 * otherwise hand all of it to a remote client in one read_files call.
 *
 * The list is deliberately conservative: it prefers a rare false positive
 * (an innocent file whose name looks like a key) over a false negative, and
 * every miss can be reported upstream instead of silently leaking.
 */
const SENSITIVE_SUFFIXES = [".pem", ".key", ".pfx", ".p12", ".jks", ".keystore"];
const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".htpasswd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
/** .env variants that are documentation, not secrets. */
const SAFE_ENV_VARIANTS = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

/**
 * True when the file looks like credential material. Name-based only: content
 * sniffing would mean reading the very file we are trying to protect.
 */
function isSensitiveFile(fsPath) {
  if (allowSecretFiles()) return false;
  const resolved = path.resolve(String(fsPath || ""));
  const base = path.basename(resolved).toLowerCase();

  if (base.startsWith(".env") && !SAFE_ENV_VARIANTS.has(base)) return true;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix)) && !base.endsWith(".pub")) return true;
  // ~/.aws/credentials style: the file "credentials"/"config" inside a ".aws" folder.
  const parent = path.basename(path.dirname(resolved)).toLowerCase();
  if (parent === ".aws" && (base === "credentials" || base === "config")) return true;
  return false;
}

/**
 * Master switch: codedock.allowSecretFiles.
 *
 * Off by default. Turning it on hands every secret in the workspace to the
 * remote client on the first read - the same weight as allowOutsideWorkspace,
 * so it lives beside it in the panel and defaults to off.
 */
function allowSecretFiles() {
  try {
    return vscode.workspace.getConfiguration("codedock").get("allowSecretFiles", false) === true;
  } catch {
    return false;
  }
}

/** Exact files approved for THIS session ("本次会话允许" on the prompt below). */
const sessionSecrets = new Set();

/** Grant one exact file for this session. Deliberately per-file: approving .env must not approve id_rsa. */
function approveSecretForSession(fsPath) {
  sessionSecrets.add(path.resolve(fsPath));
}

/**
 * Refuse reads of credential material unless the user has approved this exact
 * file. Same shape as resolvePath's boundary prompt: the call fails now with a
 * message telling the caller to retry, the modal fires, and approval takes
 * effect on the retry. Escape / closing the dialog approves nothing.
 */
function guardSecretRead(fsPath) {
  const resolved = path.resolve(fsPath);
  if (!isSensitiveFile(resolved)) return;
  if (sessionSecrets.has(resolved)) return;
  promptForSecretAccess(resolved);
  throw new Error(
    `[credential guard] "${displayPath(resolved)}" looks like credential material (.env, private key, token file). ` +
      `Reads of secret files are refused by default; do not try to reach the contents through search or another tool. ` +
      `已在 VS Code 中弹出授权请求 - 用户选择「本次会话允许」后重试本次调用即可（授权在重启后失效）。` +
      `Ask the user to paste the specific value you need instead.`
  );
}

/** One live prompt per file, so a retry burst cannot stack identical dialogs. */
const pendingSecretPrompts = new Map();

function promptForSecretAccess(resolved) {
  if (pendingSecretPrompts.has(resolved)) return;
  const done = Promise.resolve(
    vscode.window.showWarningMessage(
      `远程 AI 请求读取疑似凭据文件\n\n${resolved}\n\n` +
        `这类文件（.env、私钥、令牌文件）默认禁止远程读取。允许本次会话读取这一个文件吗？\n\n` +
        `重启 VS Code 后失效。如需长期放开，可在设置里开启 codedock.allowSecretFiles（等于把工作区内的密钥都交给远程会话，请谨慎）。`,
      { modal: true },
      "本次会话允许",
      "拒绝"
    )
  )
    .then((answer) => {
      if (answer === "本次会话允许") approveSecretForSession(resolved);
    })
    .catch(() => {})
    .then(() => pendingSecretPrompts.delete(resolved));
  pendingSecretPrompts.set(resolved, done);
}

/** Workspace-relative display path, so tool output stays short and readable. */
function displayPath(fsPath) {
  for (const root of roots()) {
    if (isInside(path.resolve(fsPath), path.resolve(root))) {
      const rel = path.relative(path.resolve(root), path.resolve(fsPath));
      return rel ? rel.split(path.sep).join("/") : ".";
    }
  }
  return fsPath;
}

function toUri(fsPath) {
  return vscode.Uri.file(resolvePath(fsPath));
}

module.exports = {
  roots,
  primaryRoot,
  inScope,
  resolvePath,
  displayPath,
  toUri,
  isInside,
  isSensitiveFile,
  guardSecretRead,
  approveSecretForSession,
};
