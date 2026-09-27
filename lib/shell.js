/**
 * Shell selection for spawned commands.
 *
 * The tool contract says "PowerShell on Windows". Node's spawn({shell:true})
 * does not deliver that: on Windows it follows ComSpec, which is cmd.exe, so a
 * model writing PowerShell (`$env:X=1`, Get-Content) would silently fail. We
 * resolve an explicit PowerShell executable instead (PowerShell 7 when present,
 * the inbox Windows PowerShell otherwise). Non-Windows keeps the system shell.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

let cached;

function resolveShell() {
  if (cached !== undefined) return cached;

  if (process.platform !== "win32") {
    cached = true; // let Node pick /bin/sh
    return cached;
  }

  const pf = process.env["ProgramFiles"];
  const winDir = process.env.SystemRoot || path.join(process.env.SystemDrive || "C:", "Windows");
  const candidates = [
    pf && path.join(pf, "PowerShell", "7", "pwsh.exe"),
    path.join(winDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cached = candidate;
        return cached;
      }
    } catch {}
  }

  // No PowerShell found (stripped-down image): fall back to the platform
  // default rather than failing every command.
  cached = true;
  return cached;
}

/** Spawn options shared by run_command and workspace-declared tools. */
function spawnOptions(extra = {}) {
  return {
    shell: resolveShell(),
    windowsHide: true,
    env: process.env,
    // On POSIX we kill whole process groups; the child has to lead its own
    // group for process.kill(-pid) to reach it. Windows uses taskkill /T,
    // which walks the job tree without this.
    detached: process.platform !== "win32",
    ...extra,
  };
}

/**
 * Kill a spawned child together with everything it started.
 *
 * Windows: taskkill /T walks the process tree. POSIX: the child was spawned
 * detached, so it leads its own process group and -pid reaches the whole tree;
 * the bare pid kill is only a fallback.
 */
function killProcessTree(child) {
  return new Promise((resolve) => {
    const pid = child && child.pid;
    if (!pid) {
      resolve();
      return;
    }
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      resolve();
    }
  });
}

module.exports = { resolveShell, spawnOptions, killProcessTree };

