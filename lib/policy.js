/**
 * Permission policy.
 *
 * A token proves *who* is calling, never *what they may do*. Every tool is
 * tagged with one of three capabilities, and the bridge refuses anything above
 * what the user has switched on:
 *
 *   read     - observe the workspace, change nothing
 *   edit     - create, modify or delete files
 *   execute  - start processes, or drive processes that are already running
 *
 * Two decisions here are deliberate:
 *
 * 1. The default for an unclassified tool is the strictest level, not the
 *    loosest. A tool nobody classified is a tool nobody has reason to trust -
 *    this is what covers workspace-declared tools, which are shell templates
 *    by construction.
 *
 * 2. `cancel_command` and `get_command_output` are read-level even though they
 *    belong to the command family. Observing output and *stopping* work only
 *    ever move in the safe direction, and they must keep working after the user
 *    revokes Execute, or a runaway command could not be shut down.
 *
 * Denials are written for the model rather than for a log file: the message
 * names the missing capability and says where to grant it, so a remote AI can
 * ask the user for the right thing instead of retrying blindly.
 */

const vscode = require("vscode");

const LEVELS = ["read", "edit", "execute"];

const LABELS = { read: "Read", edit: "Edit", execute: "Execute" };

const BLURBS = {
  read: "读取和搜索工作区内容，不修改任何东西。",
  edit: "创建、修改、删除文件（改动在编辑器里可撤销）。",
  execute: "执行 shell 命令，并驱动已启动的进程。",
};

/** Tool name -> capability. */
const CAPABILITY = {
  // observe only
  read_files: "read",
  read_image: "read",
  list_directory: "read",
  find_files: "read",
  search_files: "read",
  get_diagnostics: "read",
  lsp: "read",
  list_skills: "read",
  read_skill: "read",
  list_jobs: "read",
  get_command_output: "read",
  cancel_command: "read",
  report_progress: "read",
  set_todos: "read",
  update_plan: "read",
  // Toolchain inspection only reads machine/workspace state.
  dotnet_detect: "read",
  godot_detect: "read",
  // Git queries change nothing (same rationale as dotnet_detect).
  git_status: "read",
  git_diff: "read",
  git_log: "read",
  git_show: "read",
  git_branch: "read",

  // touch the filesystem. apply_patch (create/replace/delete text) is the
  // whole edit surface for plain files; the git state-writers rewrite local
  // repository state only (no network, recoverable through git itself).
  apply_patch: "edit",
  git_stage: "edit",
  git_commit: "edit",
  git_checkout: "edit",

  // start or drive processes
  run_command: "execute",
  send_command_input: "execute",
  dotnet_build: "execute",
  dotnet_test: "execute",
  dotnet_run: "execute",
  dotnet_publish: "execute",
  dotnet_restore: "execute",
  godot_import: "execute",
  godot_run: "execute",
  godot_export: "execute",
  godot_check: "execute",
  // Network-touching git operations.
  git_push: "execute",
  git_pull: "execute",
};

const DEFAULT_CAPABILITY = "execute";

function config() {
  const cfg = vscode.workspace.getConfiguration("codedock");
  return {
    read: cfg.get("permission.read", true) !== false,
    edit: cfg.get("permission.edit", true) !== false,
    execute: cfg.get("permission.execute", false) === true,
  };
}

/**
 * Capability levels that other modules registered at runtime.
 *
 * Kept separate from the table above because this is runtime state, not a code
 * constant. Only trusted code paths may register here, and never BELOW what the
 * tool actually is: workspace-declared shell templates register as execute even
 * when their manifest says "read", because a manifest is a workspace file the
 * remote AI can write once it has edit permission.
 */
const DECLARED = new Map();

function register(toolName, capability) {
  if (LEVELS.includes(capability)) DECLARED.set(toolName, capability);
  else DECLARED.delete(toolName);
}

/**
 * Drop declarations of manifests that are no longer present. Called after a
 * fresh manifest scan, so deleting a .codedock/tools file takes its capability
 * assignment away instead of leaving it registered forever.
 */
function syncDeclared(activeNames) {
  for (const name of [...DECLARED.keys()]) {
    if (!activeNames.includes(name)) DECLARED.delete(name);
  }
}

function capabilityOf(toolName) {
  return CAPABILITY[toolName] || DECLARED.get(toolName) || DEFAULT_CAPABILITY;
}

function isAllowed(toolName) {
  return config()[capabilityOf(toolName)] === true;
}

function denialMessage(toolName, level) {
  return [
    `[permission denied] "${toolName}" needs the ${LABELS[level]} permission, which is currently OFF.`,
    "",
    `Current permissions: ${LEVELS.map((l) => `${LABELS[l]}=${config()[l] ? "ON" : "OFF"}`).join(", ")}.`,
    `Ask the user to open the CodeDock control panel and tick "${LABELS[level]}" under Permissions, then retry.`,
    "Do not try to reach the same effect through a different tool.",
  ].join("\n");
}

/**
 * Throws when the tool is above the granted level.
 *
 * Every call funnels through here before the tool runs, so no tool has to
 * remember to check for itself.
 */
function ensureAllowed(toolName) {
  const level = capabilityOf(toolName);
  if (config()[level] === true) return;
  throw new Error(denialMessage(toolName, level));
}

/** Snapshot for the control panel. */
function describe() {
  const current = config();
  return LEVELS.map((level) => ({
    level,
    label: LABELS[level],
    blurb: BLURBS[level],
    enabled: current[level] === true,
  }));
}

/**
 * How many tools each level unlocks, for the panel summary.
 *
 * Defaults to the built-ins in the table above. Workspace-declared tools are
 * only counted when the caller passes the live name list, since their number
 * changes with whichever workspace happens to be open.
 */
function counts(toolNames) {
  const names = Array.isArray(toolNames) && toolNames.length ? toolNames : Object.keys(CAPABILITY);
  const result = { read: 0, edit: 0, execute: 0 };
  for (const name of names) result[capabilityOf(name)] += 1;
  return result;
}

/** Capability of each tool, for the activity feed and diagnostics. */
function mapOf(toolNames) {
  const result = {};
  for (const name of toolNames) result[name] = capabilityOf(name);
  return result;
}

module.exports = {
  LEVELS,
  LABELS,
  capabilityOf,
  register,
  syncDeclared,
  isAllowed,
  ensureAllowed,
  describe,
  counts,
  mapOf,
};

