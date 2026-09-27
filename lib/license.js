/**
 * Licence keys (CDK).
 *
 * One thing shapes this whole file: a check that runs on the user's machine can
 * always be stepped over. Whoever can open the extension folder can patch out
 * `if (!valid) return`. Encrypting the check does not help - the decryption
 * would have to happen locally too, with the key sitting right there.
 *
 * So the goal is not "nobody can bypass this". It is two narrower, achievable
 * things:
 *
 *   1. Keys cannot be FORGED. A key carries an Ed25519 signature and only the
 *      issuer holds the private half. Editing the payload to extend the expiry
 *      or raise the seat count invalidates it. This is the part that stops
 *      "crack the format once, generate keys forever".
 *
 *   2. Keys can be REVOKED. That is what the `id` field is for - the issuer
 *      keeps a list. Without a server this can only be checked at issue time, so
 *      anything the business actually depends on should be gated on a runtime
 *      value the server hands out, not on this local check.
 *
 * Point 2 is where real protection lives. Recommended shape for this project:
 * give the local tool away and licence something the server has to provide -
 * see the note in README about the public tunnel.
 *
 * Verification stays OFF until `codedock.licensePublicKey` is set, so a checkout
 * or a fork is never locked out by an empty key.
 */

const vscode = require("vscode");
const crypto = require("crypto");

// The prefix is compared case-insensitively; the base64url segments are case-sensitive.
const KEY_PREFIX = "CODEDOCK";
const SECRET_NAME = "codedock.licenseKey";

/** ExtensionContext.secrets, injected from activate(). */
let secrets = null;

function init(context) {
  secrets = context && context.secrets ? context.secrets : null;
}

function publicKeyPem() {
  return String(vscode.workspace.getConfiguration("codedock").get("licensePublicKey", "") || "").trim();
}

/** Whether this build enforces keys at all. */
function enforced() {
  return publicKeyPem().length > 0;
}

function fromBase64Url(text) {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

/**
 * Strip whitespace so a key survives being pasted with spaces or line wrapping.
 *
 * NOTHING else may be touched: the payload and signature segments are base64url,
 * which is case-sensitive and uses `-` and `_` as alphabet characters. The old
 * uppercase-and-strip normalization corrupted every legitimately issued key
 * (signature verification could never pass). Only the prefix is case-folded,
 * and only at comparison time.
 */
function normalize(input) {
  return String(input || "").replace(/\s+/g, "");
}

function parse(key) {
  const parts = normalize(key).split(".");
  if (parts.length !== 3 || parts[0].toUpperCase() !== KEY_PREFIX) return null;
  try {
    const payload = fromBase64Url(parts[1]).toString("utf8");
    const signature = fromBase64Url(parts[2]);
    if (!payload || !signature.length) return null;
    return { payload, signature, raw: String(key).trim() };
  } catch {
    return null;
  }
}

/**
 * Verify a key: signature first, then expiry.
 *
 * Signature comes first on purpose. Checking the expiry of a forged payload
 * would mean reporting "expired" for something that was never valid, which is
 * confusing in a support conversation.
 */
function verifyKey(key) {
  if (!enforced()) return { valid: false, reason: "not-configured" };

  const parsed = parse(key);
  if (!parsed) return { valid: false, reason: "malformed" };

  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      null, // Ed25519 signs the message directly; no separate digest
      Buffer.from(parsed.payload, "utf8"),
      crypto.createPublicKey(publicKeyPem()),
      parsed.signature
    );
  } catch {
    // A malformed configured public key lands here, not on the customer.
    return { valid: false, reason: "bad-public-key" };
  }
  if (!signatureOk) return { valid: false, reason: "bad-signature" };

  let data;
  try {
    data = JSON.parse(parsed.payload);
  } catch {
    return { valid: false, reason: "bad-payload" };
  }

  if (data.exp) {
    const expiry = new Date(`${data.exp}T23:59:59Z`);
    if (Number.isNaN(expiry.getTime())) return { valid: false, reason: "bad-expiry", payload: data };
    if (Date.now() > expiry.getTime()) return { valid: false, reason: "expired", payload: data };
  }

  return { valid: true, payload: data };
}

async function load() {
  if (!secrets) return null;
  try {
    return await secrets.get(SECRET_NAME);
  } catch {
    return null;
  }
}

async function save(key) {
  if (!secrets) throw new Error("licence storage is not available");
  await secrets.store(SECRET_NAME, String(key).trim());
}

async function clear() {
  if (secrets) await secrets.delete(SECRET_NAME);
}

/**
 * The one question the rest of the extension asks: may this run?
 *
 * Deliberately cheap and synchronous for callers - the stored key is checked on
 * demand. Everything that matters should ALSO be gated on something the server
 * issues, because this answer is only as trustworthy as the machine it runs on.
 */
async function isActive() {
  if (!enforced()) return true;
  const stored = await load();
  return stored ? verifyKey(stored).valid : false;
}

/** Human-readable state for the control panel. */
async function status() {
  if (!enforced()) {
    return { enforced: false, active: true, label: "未启用校验", detail: "没有配置 licensePublicKey，所有功能开放。" };
  }

  const stored = await load();
  if (!stored) {
    return { enforced: true, active: false, label: "未激活", detail: "还没有输入 CDK。" };
  }

  const result = verifyKey(stored);
  if (result.valid) {
    const plan = result.payload.plan ? ` · ${result.payload.plan}` : "";
    const exp = result.payload.exp ? ` · 有效期至 ${result.payload.exp}` : " · 永久";
    return {
      enforced: true,
      active: true,
      label: "已激活",
      detail: `${result.payload.id || "(无 id)"}${plan}${exp}`,
      payload: result.payload,
    };
  }

  const reasons = {
    malformed: "CDK 格式不对（应形如 CODEDOCK.xxxx.yyyy）。",
    "bad-signature": "签名验证失败——这个 CDK 不是本机公钥对应的私钥签发的，或者内容被改过。",
    "bad-payload": "CDK 内容无法解析。",
    "bad-expiry": "CDK 里的有效期格式不对。",
    expired: "CDK 已过期。",
    "bad-public-key": "配置的 licensePublicKey 不是有效的公钥。",
  };
  return { enforced: true, active: false, label: "无效", detail: reasons[result.reason] || result.reason };
}

module.exports = { init, enforced, normalize, parse, verifyKey, load, save, clear, isActive, status };
