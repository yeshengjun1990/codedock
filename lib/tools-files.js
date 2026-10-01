/**
 * File tools.
 *
 * Everything here goes through the editor's own document/edit pipeline rather
 * than raw disk writes, which buys two things a plain filesystem server cannot:
 * the user sees the change as a diff they can review, and Ctrl+Z undoes it.
 */

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const scope = require("./scope");

const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** One read_files call may ask for at most this many paths. */
const MAX_READ_PATHS = 20;
/** Search budget: how far a single search_files call is allowed to roam. */
const MAX_SEARCH_FILES = 3000;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const SEARCH_BATCH = 16;
/** Images travel inline as MCP image blocks, so keep a sane ceiling. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function countLines(text) {
  if (typeof text !== "string" || !text) return 0;
  return text.split("\n").length;
}

/**
 * read_files/search_files read disk bytes, while apply_patch edits the live
 * editor buffer. When those differ (unsaved changes), the patch was anchored on
 * text the model never saw, so say so instead of silently succeeding.
 */
function dirtyNote(wasDirty) {
  return wasDirty
    ? "\nNote: the file had unsaved changes in the editor; the patch applied to that live buffer, which may differ from what you last read."
    : "";
}

/**
 * Cheap screen for catastrophic-backtracking regex shapes ((a+)+, (.*)*,
 * adjacent quantifiers). It is not a full ReDoS analyzer - it just keeps the
 * obvious host-killers out, since search_files runs with read-only permission
 * and otherwise gets unbounded CPU inside the extension host.
 */
function looksCatastrophic(source) {
  // Lazy quantifiers (*?, +?, ??) are the idiomatic "match as little as
  // possible" forms, not a backtracking hazard - and every other
  // adjacent-quantifier shape (.**, a++) is a syntax error the RegExp
  // constructor has already rejected before this screen runs. Strip the lazy
  // forms first so they are not false-positived; the classic (a+)+ shapes
  // stay covered by the first rule.
  const withoutLazy = String(source).replace(/[+*?]\?/g, "");
  return (
    /\([^()]*[+*]\w*[^()]*\)\s*[+*?]/.test(source) || // quantified group followed by a quantifier
    /[+*?]\s*[+*?]/.test(withoutLazy) || // adjacent quantifiers, e.g. .** or a**
    /\.\([^()]*\)\*/.test(source) // .(...)* style nested wildcard
  );
}

/**
 * Pre-edit snapshots.
 *
 * They live outside the workspace so they never pollute the user's git status.
 * They exist so the activity feed can open a real side-by-side diff for an edit
 * the agent already applied - by the time anyone wants to look, the file itself
 * has moved on.
 */
const SNAPSHOT_DIR = path.join(os.tmpdir(), "codedock-before");
const MAX_SNAPSHOTS = 40;

function saveBeforeSnapshot(label, text) {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const safe = String(label).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
    const file = path.join(SNAPSHOT_DIR, `${Date.now()}-${safe}`);
    fs.writeFileSync(file, text, "utf8");

    const entries = fs.readdirSync(SNAPSHOT_DIR).sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - MAX_SNAPSHOTS))) {
      try { fs.unlinkSync(path.join(SNAPSHOT_DIR, name)); } catch {}
    }
    return file;
  } catch {
    return undefined;
  }
}

async function readFileText(uri) {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`file is too large to read (${Math.round(stat.size / 1024)} KB > ${MAX_FILE_BYTES / 1024} KB)`);
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

/** Find an exact match and refuse ambiguous ones, so edits stay predictable. */
function locateUniqueRange(text, needle, label) {
  const first = text.indexOf(needle);
  if (first === -1) {
    throw new Error(
      `${label}: old_text was not found. Read the file again and copy the exact text, including indentation.`
    );
  }
  const second = text.indexOf(needle, first + 1);
  if (second !== -1) {
    throw new Error(
      `${label}: old_text matches ${text.split(needle).length - 1} places. Add more surrounding lines so it is unique.`
    );
  }
  return first;
}

function offsetToPosition(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

const TOOLS = [
  {
    name: "read_files",
    title: "Read Files",
    description:
      "Read one or more files from the open workspace (at most 20 paths per call). Always read a file before editing it. Relative paths are anchored at the workspace root. Returns the exact file text with no line numbers, so it can be copied straight into apply_patch.",
    inputSchema: {
      type: "object",
      required: ["paths"],
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths, relative to the workspace root or absolute inside it.",
        },
      },
    },
    async run(args) {
      const paths = Array.isArray(args.paths) ? args.paths : [args.paths];
      if (paths.length > MAX_READ_PATHS) {
        throw new Error(
          `too many paths in one read_files call (${paths.length} > ${MAX_READ_PATHS}); split it into batches of up to ${MAX_READ_PATHS}`
        );
      }
      const parts = [];
      for (const p of paths) {
        // Both scope resolution and the read are per-file: one bad path in a
        // batch must report [ERROR] for that file, not fail the whole batch.
        let uri;
        let label;
        try {
          uri = scope.toUri(p);
          label = scope.displayPath(uri.fsPath);
        } catch (err) {
          parts.push(`${String(p)}\n${"-".repeat(60)}\n[ERROR] ${err.message}`);
          continue;
        }
        try {
          // Credential guard runs inside the per-file try, so one refused
          // secret reports [ERROR] for that file and the rest of the batch
          // still comes back.
          scope.guardSecretRead(uri.fsPath);
          const text = await readFileText(uri);
          // read_files returns DISK bytes; a dirty editor buffer means what
          // the user is looking at differs from it - say so instead of
          // letting the model patch against stale text.
          const openDocs = Array.isArray(vscode.workspace.textDocuments)
            ? vscode.workspace.textDocuments
            : [];
          const dirty = openDocs.some((doc) => doc.uri.toString() === uri.toString() && doc.isDirty);
          parts.push(
            `${label}\n${"-".repeat(60)}\n${text}${
              dirty ? "\n[editor] this file has unsaved changes in the editor; the content above is the on-disk version." : ""
            }`
          );
        } catch (err) {
          parts.push(`${label}\n${"-".repeat(60)}\n[ERROR] ${err.message}`);
        }
      }
      return parts.join("\n\n");
    },
  },

  {
    name: "read_image",
    title: "Read Image",
    description:
      "Read an image file and actually see it - screenshots, UI mockups, diagrams, photos. The pixels are returned as an MCP image block, so you can describe or reason about what is in the picture rather than only its metadata. Supported formats: png, jpg, jpeg, gif, webp.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Image path, relative to the workspace root or absolute inside it." },
      },
    },
    async run(args) {
      const uri = scope.toUri(args.path);
      const ext = path.extname(uri.fsPath).toLowerCase();
      const mimeType = IMAGE_MIME_TYPES[ext];
      if (!mimeType) {
        throw new Error(
          `unsupported image type "${ext || "(none)"}". Supported: ${Object.keys(IMAGE_MIME_TYPES).join(", ")}`
        );
      }

      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `image is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`
        );
      }

      const label = `${scope.displayPath(uri.fsPath)} — ${mimeType}, ${Math.round(stat.size / 1024)} KB`;
      const sendImages = vscode.workspace.getConfiguration("codedock").get("sendImages") !== false;
      if (!sendImages) {
        return `${label}\n(image data not sent: codedock.sendImages is turned off)`;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      return [
        { type: "text", text: label },
        { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
      ];
    },
  },

  {
    name: "list_directory",
    title: "List Directory",
    description:
      "List the immediate contents of one directory - directories first, then files. Use this to look at a single level; use find_files when you want to match patterns across the whole tree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list. Defaults to the workspace root." },
        show_hidden: { type: "boolean", description: "Include dotfiles and dotfolders. Default false." },
        max_entries: { type: "number", description: "Default 300, max 2000." },
      },
    },
    async run(args) {
      const root = scope.primaryRoot();
      if (!root) throw new Error("No folder is open in this window.");

      const uri = args.path ? scope.toUri(args.path) : vscode.Uri.file(root);
      const max = Math.min(Number(args.max_entries) || 300, 2000);

      const entries = await vscode.workspace.fs.readDirectory(uri);
      const rows = entries
        .filter(([name]) => args.show_hidden || !name.startsWith("."))
        .map(([name, type]) => ({ name, dir: (type & vscode.FileType.Directory) !== 0 }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

      if (!rows.length) return `${scope.displayPath(uri.fsPath)} is empty`;

      const shown = rows.slice(0, max);
      const lines = shown.map((row) => (row.dir ? `[dir]  ${row.name}/` : `[file] ${row.name}`));
      const more = rows.length > shown.length ? `\n... ${rows.length - shown.length} more (raise max_entries)` : "";
      return `${scope.displayPath(uri.fsPath)}: ${rows.length} entries\n${lines.join("\n")}${more}`;
    },
  },

  {
    name: "apply_patch",
    title: "Apply Patch",
    description:
      "Edit files through the editor, so changes appear as a reviewable diff and can be undone with Ctrl+Z. Modes: pass `edits` to replace exact text fragments (each old_text must match exactly once), pass `content` to create a file / replace its whole contents, pass `delete: true` to remove the file, or pass `rename_to` to move/rename it inside the workspace. One mode per call. Prefer small, surgical edits with enough surrounding context.",
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: {
        file_path: { type: "string", description: "Target file, relative to the workspace root or absolute inside it." },
        edits: {
          type: "array",
          description: "List of exact-text replacements, applied in order.",
          items: {
            type: "object",
            required: ["old_text", "new_text"],
            properties: {
              old_text: { type: "string", description: "Exact existing text, including indentation. Must match exactly once." },
              new_text: { type: "string", description: "Replacement text. Use an empty string to delete." },
            },
          },
        },
        content: {
          type: "string",
          description: "Full file content. Creates the file when it does not exist, otherwise replaces everything.",
        },
        delete: {
          type: "boolean",
          description: "Remove the file. Cannot be combined with edits, content or rename_to.",
        },
        rename_to: {
          type: "string",
          description: "Move/rename the file to this workspace path (parent directory must exist). Cannot be combined with edits, content or delete.",
        },
      },
    },
    async run(args) {
      const uri = scope.toUri(args.file_path);
      const label = scope.displayPath(uri.fsPath);
      let exists = true;

      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        exists = false;
      }

      // --- file operations: delete / rename ----------------------------------
      // Both go through WorkspaceEdit file operations, so the editor's own undo
      // stack can bring the file back - the same reversibility as text edits.
      const wantsDelete = args.delete === true;
      const wantsRename = typeof args.rename_to === "string" && args.rename_to.trim().length > 0;
      if (wantsDelete || wantsRename) {
        if (args.content != null || (Array.isArray(args.edits) && args.edits.length)) {
          throw new Error("combine nothing with delete / rename_to - one operation per apply_patch call");
        }
        if (wantsDelete && wantsRename) {
          throw new Error("delete and rename_to are mutually exclusive");
        }
        if (!exists) {
          throw new Error(`${label} does not exist`);
        }

        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          throw new Error(`${label} is a directory - apply_patch file operations work on single files`);
        }

        let beforeText = "";
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          beforeText = doc.getText();
        } catch {
          // binary or unreadable - the pre-change snapshot just stays empty
        }

        if (wantsDelete) {
          const removal = new vscode.WorkspaceEdit();
          removal.deleteFile(uri, { ignoreIfNotExists: false, recursive: false });
          const ok = await vscode.workspace.applyEdit(removal);
          if (!ok) throw new Error("the editor refused the delete");
          return {
            text: `deleted ${label}`,
            meta: { file: label, deleted: true, beforePath: saveBeforeSnapshot(label, beforeText) },
          };
        }

        const target = scope.resolvePath(args.rename_to.trim());
        if (target === uri.fsPath) {
          throw new Error("rename_to is the same as the current path");
        }
        let targetExists = false;
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(target));
          targetExists = true;
        } catch {}
        if (targetExists) {
          throw new Error(`rename target already exists: ${scope.displayPath(target)}`);
        }
        if (!fs.existsSync(path.dirname(target))) {
          throw new Error(`rename target directory does not exist: ${scope.displayPath(path.dirname(target))}`);
        }

        const targetLabel = scope.displayPath(target);
        const renameEdit = new vscode.WorkspaceEdit();
        renameEdit.renameFile(uri, vscode.Uri.file(target), { overwrite: false });
        const ok = await vscode.workspace.applyEdit(renameEdit);
        if (!ok) throw new Error("the editor refused the rename");
        return {
          text: `renamed ${label} -> ${targetLabel}`,
          meta: { file: targetLabel, renamed_from: label, beforePath: saveBeforeSnapshot(targetLabel, beforeText) },
        };
      }

      const edit = new vscode.WorkspaceEdit();

      if (typeof args.content === "string") {
        if (!exists) {
          // createFile and the text insertion must be TWO applyEdit calls: in
          // the real editor, bundling them into one WorkspaceEdit creates the
          // file but silently drops the inserted text (an empty file).
          edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
          const created = await vscode.workspace.applyEdit(edit);
          if (!created) throw new Error("the editor refused to create the file");

          const insertEdit = new vscode.WorkspaceEdit();
          insertEdit.insert(uri, new vscode.Position(0, 0), args.content);
          const inserted = await vscode.workspace.applyEdit(insertEdit);
          if (!inserted) throw new Error("the editor refused the file content");

          const createdDoc = await vscode.workspace.openTextDocument(uri);
          await createdDoc.save();
          return {
            text: `created ${label} (${args.content.length} chars)`,
            meta: {
              file: label,
              added: countLines(args.content),
              removed: 0,
              beforePath: saveBeforeSnapshot(label, ""),
            },
          };
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const wasDirty = document.isDirty;
        const beforeText = document.getText();
        const full = new vscode.Range(document.positionAt(0), document.positionAt(beforeText.length));
        edit.replace(uri, full, args.content);
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) throw new Error("the editor refused the edit");
        await document.save();
        return {
          text: `replaced the full contents of ${label} (${args.content.length} chars)${dirtyNote(wasDirty)}`,
          meta: {
            file: label,
            added: countLines(args.content),
            removed: countLines(beforeText),
            beforePath: saveBeforeSnapshot(label, beforeText),
          },
        };
      }

      if (!exists) {
        throw new Error(`${label} does not exist. Pass \`content\` to create it.`);
      }

      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (!edits.length) {
        throw new Error("nothing to do: pass either `edits` or `content`.");
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const wasDirty = document.isDirty;
      const beforeText = document.getText();
      const applied = [];

      // IMPORTANT: every Range in one WorkspaceEdit addresses the SAME original
      // document snapshot - the editor applies the batch atomically (internally
      // bottom-up). Locating later anchors against an already-rewritten string
      // makes their positions wrong as soon as an earlier edit changes the
      // length. All anchors are therefore located in the original text, and
      // spans are rejected up front when they overlap.
      const spans = [];
      for (let i = 0; i < edits.length; i++) {
        const item = edits[i];
        const tag = `edit #${i + 1}`;
        if (typeof item.old_text !== "string" || typeof item.new_text !== "string") {
          throw new Error(`${tag}: old_text and new_text must both be strings.`);
        }
        const offset = locateUniqueRange(beforeText, item.old_text, tag);
        const end = offset + item.old_text.length;
        for (const prev of spans) {
          if (offset < prev.end && prev.start < end) {
            throw new Error(
              `${tag} overlaps ${prev.tag}. Merge the two edits, or make their old_text regions disjoint.`
            );
          }
        }
        spans.push({ start: offset, end, tag });
        const startPos = offsetToPosition(beforeText, offset);
        const endPos = offsetToPosition(beforeText, end);
        edit.replace(uri, new vscode.Range(startPos, endPos), item.new_text);
        applied.push(`#${i + 1} replaced ${item.old_text.length} chars with ${item.new_text.length}`);
      }

      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error("the editor refused the edit");
      await document.save();

      let added = 0;
      let removed = 0;
      for (const item of edits) {
        added += countLines(item.new_text);
        removed += countLines(item.old_text);
      }

      return {
        text: `${label}: ${applied.length} edit(s) applied\n${applied.join("\n")}${dirtyNote(wasDirty)}`,
        meta: {
          file: label,
          edits: applied.length,
          added,
          removed,
          beforePath: saveBeforeSnapshot(label, beforeText),
        },
      };
    },
  },

  {
    name: "find_files",
    title: "Find Files",
    description:
      "List files by glob pattern, for example **/*.ts or src/**/*.json. Use this to discover structure instead of guessing paths.",
    inputSchema: {
      type: "object",
      required: ["glob"],
      properties: {
        glob: { type: "string", description: "Glob pattern, for example **/*.js" },
        exclude: { type: "string", description: "Optional exclude glob; defaults to node_modules, .git, dist, out and build" },
        max_results: { type: "number", description: "Default 200, max 1000." },
      },
    },
    async run(args) {
      const exclude = args.exclude || "**/{node_modules,.git,dist,out,build}/**";
      const max = Math.min(Number(args.max_results) || 200, 1000);
      const uris = await vscode.workspace.findFiles(args.glob, exclude, max);
      if (!uris.length) return `no files matched ${args.glob}`;
      const lines = uris.map((uri) => scope.displayPath(uri.fsPath)).sort();
      return `${lines.length} file(s)\n${lines.join("\n")}`;
    },
  },

  {
    name: "search_files",
    title: "Search Files",
    description:
      "Raw text or regular expression search across the workspace, returning file, line number and the matching line. Use this for exact strings; use the lsp tool for symbols, definitions and references.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Text or regular expression to search for." },
        is_regex: { type: "boolean", description: "Treat query as a regular expression. Default false." },
        is_case_sensitive: { type: "boolean", description: "Default false." },
        include: { type: "string", description: "Optional include glob, for example src/**/*.ts" },
        max_results: { type: "number", description: "Default 200, max 1000." },
      },
    },
    async run(args) {
      const max = Math.min(Number(args.max_results) || 200, 1000);
      const include = args.include || "**/*";
      const exclude = "**/{node_modules,.git,dist,out,build,.next,.venv,venv,__pycache__,target}/**";
      const caseSensitive = Boolean(args.is_case_sensitive);

      let matches;
      if (args.is_regex) {
        let regex;
        try {
          regex = new RegExp(args.query, caseSensitive ? "" : "i");
        } catch (err) {
          throw new Error(`invalid regular expression: ${err.message}`);
        }
        if (looksCatastrophic(args.query)) {
          throw new Error(
            "regular expression rejected: pattern looks susceptible to catastrophic backtracking (nested/adjacent quantifiers). Simplify it, or use a plain-text search."
          );
        }
        matches = (line) => regex.test(line);
      } else {
        const needle = caseSensitive ? args.query : String(args.query).toLowerCase();
        matches = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
      }

      // findFiles is a stable API (it uses the editor's own ripgrep internally),
      // so file discovery stays fast. The scan itself is done here instead of
      // with workspace.findTextInFiles, which is a proposed API and therefore
      // rejected outright by editors that do not enable the proposal.
      let uris = await vscode.workspace.findFiles(include, exclude, MAX_SEARCH_FILES);
      // Credential files never join the scan, and the omission is silent on
      // purpose: telling the model "2 secret files were excluded" would leak
      // that they exist and invite a retry through another tool. The cap note
      // below is judged on the pre-filter count, since the filter only shrinks
      // the list.
      const discovered = uris.length;
      uris = uris.filter((uri) => !scope.isSensitiveFile(uri.fsPath));
      const hits = [];

      for (let i = 0; i < uris.length && hits.length < max; i += SEARCH_BATCH) {
        const batch = uris.slice(i, i + SEARCH_BATCH);
        const loaded = await Promise.all(
          batch.map(async (uri) => {
            try {
              const stat = await vscode.workspace.fs.stat(uri);
              if (stat.size > MAX_SEARCH_FILE_BYTES) return null;
              const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
              // A NUL byte is the usual tell for a binary file.
              return text.includes("\u0000") ? null : { uri, text };
            } catch {
              return null;
            }
          })
        );

        for (const item of loaded) {
          if (!item || hits.length >= max) continue;
          const lines = item.text.split(/\r?\n/);
          for (let n = 0; n < lines.length && hits.length < max; n++) {
            if (!matches(lines[n])) continue;
            const snippet = lines[n].trim();
            hits.push(
              `${scope.displayPath(item.uri.fsPath)}:${n + 1}: ${snippet.length > 240 ? `${snippet.slice(0, 240)}…` : snippet}`
            );
          }
        }
      }

      if (!hits.length) {
        const scopeNote = discovered >= MAX_SEARCH_FILES ? ` (scanned the first ${MAX_SEARCH_FILES} files)` : "";
        return `no matches for ${JSON.stringify(args.query)}${scopeNote}`;
      }

      const notes = [];
      if (hits.length >= max) notes.push(`stopped at ${max} matches - narrow it with include or max_results`);
      if (discovered >= MAX_SEARCH_FILES) notes.push(`only the first ${MAX_SEARCH_FILES} files were scanned`);
      const suffix = notes.length ? `\n(${notes.join("; ")})` : "";
      return `${hits.length} match(es)\n${hits.join("\n")}${suffix}`;
    },
  },
];

module.exports = { TOOLS, readFileText };
