/**
 * Pre-flight guard for shell commands.
 *
 * Execute permission answers a coarse question: "may this AI run commands at
 * all". This answers a narrower one: "is *this* command one of the shapes that
 * turns a mistake into data loss".
 *
 * It is a set of heuristics, not a sandbox, and it is deliberately narrow. A
 * guard that cries wolf gets clicked through without reading, which is worse
 * than no guard at all - so patterns anchor on command position and require the
 * dangerous flags, rather than matching a scary word anywhere in the string.
 *
 * Commands hidden inside quotes (`cmd /c "..."`, `sudo sh -c '...'`,
 * `powershell -Command "..."`) are scanned too: each quoted span is searched
 * as its own command line, otherwise wrapping a payload is a free bypass.
 *
 * A hit blocks nothing by itself. It pauses the call and asks the person whose
 * machine it is, which is where that decision actually belongs.
 */

const vscode = require("vscode");

/** Someone who walks away from a modal should not leave a call hanging forever. */
const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

const PATTERNS = [
  // GNU/Unix/Git-Bash rm with a recursive or force flag among its OWN
  // arguments, tolerating sudo/env/command style prefixes and flags placed
  // after operands (`rm build -rf` is legal). The flag scan is bounded by the
  // next command separator, so an -r/-f belonging to a LATER command in the
  // same line (`rm note.txt && ls -r src`) cannot trip it. Long-form GNU flags
  // count too: the `-` in `--recursive` never follows whitespace, so without
  // the explicit `--` branch the short-flag cluster below cannot see it.
  {
    re: /(?:^|[;&|(]\s*)(?:(?:sudo|doas|nohup|command)\s+)*(?:env\s+(?:[A-Za-z_][\w.]*=\S*\s+)*)?rm\b(?=[^;&|()]*(?:\s-[A-Za-z]*[rfR][A-Za-z]*|\s--(?:recursive|force)\b))/i,
    label: "递归或强制删除（rm -rf）",
  },
  // cmd.exe recursive deletion: /s among its own arguments.
  {
    re: /(?:^|[;&|(]\s*)(?:del|erase|rd|rmdir)\b(?=[^;&|()]*\s\/s\b)/i,
    label: "递归删除（del/rd /s）",
  },
  // PowerShell Remove-Item (also under aliases ri/del/erase/rd/rmdir/rm) with
  // BOTH -Recurse and -Force; parameter name prefixes count (-r, -re, -recu;
  // -fo uniquely resolves to -Force while -fi is -Filter).
  {
    re: /(?:^|[;&|(]\s*)(?:remove-item|ri|del|erase|rd|rmdir|rm)\b(?=[^;&|()]*\s-r\w*\b)(?=[^;&|()]*\s-fo\w*\b)/i,
    label: "递归强制删除（Remove-Item -Recurse -Force）",
  },
  // git push --force / -f / a +refspec (all three force), but a
  // lease-protected push on its own is allowed. Each --force occurrence is
  // judged individually, so a --force-with-lease elsewhere on the line no
  // longer exempts a bare --force sitting next to it. A leading + in a
  // refspec forces with or without an explicit destination (+main and
  // +main:main both count).
  {
    re: /git\s+push\b(?=[^;&|()]*(?:\s--force(?![-\w])|\s-f\b|\s\+[\w./*-]+(?::[\w./*-]+)?))/i,
    label: "强制推送（git push --force）",
  },
  { re: /git\s+reset\s+--hard\b/i, label: "丢弃改动（git reset --hard）" },
  { re: /git\s+clean\b[^|;]*\s-\S*f/i, label: "清除未跟踪文件（git clean -f）" },
  // Discarding uncommitted work: `git checkout -- <path>` / `git checkout .` /
  // `git restore .` / `git restore --worktree`. Plain branch switches
  // (`git checkout main`) and staged-only unstaging (`git restore --staged f`)
  // are safe and deliberately not matched.
  {
    re: /(?:^|[;&|(]\s*)git\s+(?:checkout|restore)\b(?=[^;&|()]{0,120}?\s(?:--(?:\s|$)|\.(?:\s|$)))/i,
    label: "丢弃未提交改动（git checkout/restore）",
  },
  {
    re: /(?:^|[;&|(]\s*)(?:format|mkfs\S*|diskpart|fdisk|diskutil|clear-disk|remove-partition|initialize-disk)(?=\s|$)/i,
    label: "磁盘级操作",
  },
  {
    re: /(?:^|[;&|(]\s*)(?:shutdown|reboot|halt|stop-computer)(?=\s|$)/i,
    label: "关机或重启",
  },
  // curl|sh and its PowerShell cousin iwr ... | iex.
  {
    re: /\|\s*(?:ba|z|da|k)?sh\b|(?:^|[\s;&|])(?:curl|wget|iwr|invoke-webrequest)\b[\s\S]{0,200}?\|\s*(?:iex|invoke-expression)\b/i,
    label: "把下载内容直接喂给 shell",
  },
  // PowerShell launched with an encoded payload or a hidden window - the
  // classic wrapping for something that is not meant to be seen running.
  // -en/-enc/-encodedcommand are prefixes of -EncodedCommand; bare -w is
  // -WindowStyle. (-e and -w with a longer word after them, e.g. -Wait or
  // -ExecutionPolicy, deliberately do not match.)
  {
    re: /(?:^|[;&|(]\s*)(?:powershell|pwsh)(?:\.exe)?\b(?=[^;&|()]{0,400}\s-(?:enc(?:odedcommand)?|w|windowstyle)\b)/i,
    label: "隐藏或编码执行的 PowerShell",
  },
  // Fork bomb under any function name (:(){ :|:& };: or f(){ f|f& };f). The
  // function name is captured and must appear in the body (self-invocation),
  // which keeps ordinary function definitions out of jail.
  {
    re: /(?:^|[\s;&|(])([A-Za-z_]\w*|:)\s*\(\s*\)\s*\{\s*[\s\S]{0,120}?\1[\s\S]{0,60}?\}\s*;\s*\1(?![A-Za-z0-9_])/,
    label: "fork 炸弹",
  },
  { re: /chmod\s+-R\s+777\b/i, label: "递归放开全部权限" },
  { re: /(?:npm|yarn|pnpm)\s+(?:publish|unpublish)\b/i, label: "发布到包仓库" },
  { re: /(?:^|[;&|(]\s*)dd\b(?=[^;&|()]*\bof=\/dev\/)/i, label: "裸设备写入（dd）" },
];

/**
 * Pull out quoted spans, which usually wrap a nested shell invocation.
 *
 * An opening quote must follow start-of-string, whitespace or shell
 * punctuation: a bare apostrophe inside a word (`don't panic`) is prose, and
 * pairing it with the next apostrophe used to produce nonsense spans that
 * tripped patterns on text that was never a command.
 */
function quotedSpans(text) {
  const spans = [];
  const re = /(^|[\s=:;&|,(])(["'])([\s\S]*?)\2/g;
  let match;
  while ((match = re.exec(text))) spans.push(match[3]);
  return spans;
}

/** Labels of every pattern this command trips, in declaration order. */
function scan(command) {
  const text = String(command || "");
  const labels = [];
  // Quoted spans are searched as their own command lines (below) AND blanked
  // out of the main line: a separator or parenthesis inside a quoted path
  // (`rm "a (1).txt" -rf`) is data, not shell structure, and must neither end
  // an argument segment early nor look like a subshell.
  const mainline = text.replace(/(^|[\s=:;&|,(])(["'])([\s\S]*?)\2/g, "$1");
  const haystacks = [mainline, ...quotedSpans(text)];
  for (const haystack of haystacks) {
    for (const { re, label } of PATTERNS) {
      if (re.test(haystack) && !labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}

/**
 * Ask the user whether to run it.
 *
 * Anything other than an explicit yes is a no: pressing Escape, closing the
 * dialog and timing out all mean the command does not run. That asymmetry is
 * the entire point of putting a human in the loop.
 */
async function confirm(command, labels, cwd) {
  const preview = String(command).replace(/\s+/g, " ").trim();
  const shown = preview.length > 400 ? `${preview.slice(0, 400)}…` : preview;

  const answer = await Promise.race([
    vscode.window.showWarningMessage(
      `远程 AI 请求执行一条高风险命令\n\n命中：${labels.join(" · ")}\n目录：${cwd}\n\n${shown}`,
      { modal: true },
      "允许一次",
      "拒绝"
    ),
    new Promise((resolve) => setTimeout(() => resolve(undefined), CONFIRM_TIMEOUT_MS)),
  ]);

  return answer === "允许一次";
}

module.exports = { scan, confirm, PATTERNS };

