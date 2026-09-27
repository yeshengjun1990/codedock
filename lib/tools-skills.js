/**
 * Agent Skills tools.
 *
 * Discovers and exposes domain rules, architecture guidelines, and skills
 * located in the workspace (e.g. .claude/skills, .agents/skills, .github/skills).
 */

const fs = require("fs");
const path = require("path");
const scope = require("./scope");

function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { attributes: {}, body: content };
  const raw = match[1];
  const body = match[2];
  const attributes = {};
  const lines = raw.split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      attributes[currentKey] = kv[2].trim();
    } else if (currentKey && line.startsWith("  ")) {
      attributes[currentKey] += " " + line.trim();
    }
  }
  return { attributes, body };
}

function findSkillPackages() {
  const roots = scope.roots();
  const packages = [];
  const candidateSubdirs = [
    path.join(".claude", "skills"),
    path.join(".agents", "skills"),
    path.join(".github", "skills"),
    path.join(".codex", "skills"),
    path.join(".gemini", "skills"),
  ];

  for (const root of roots) {
    for (const sub of candidateSubdirs) {
      const dir = path.join(root, sub);
      if (!fs.existsSync(dir)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skillDir = path.join(dir, ent.name);
        const skillMd = path.join(skillDir, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          let text = "";
          try {
            text = fs.readFileSync(skillMd, "utf8");
          } catch {}
          const { attributes } = parseFrontmatter(text);
          const name = attributes.name || ent.name;
          const description = attributes.description || `Skill ${name}`;
          packages.push({
            id: ent.name,
            name,
            description,
            relPath: path.relative(root, skillMd).replace(/\\/g, "/"),
            skillDir,
            skillMd,
            root,
          });
        }
      }
    }
  }
  return packages;
}

const TOOLS = [
  {
    name: "list_skills",
    title: "List Skills",
    description:
      "List all agent skills, architecture rules, and guidelines defined in the workspace (.agents/skills, .codex/skills, etc.). Always check this first when starting a task.",
    capability: "read",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async run() {
      const skills = findSkillPackages();
      if (!skills.length) {
        return "No agent skills found in the workspace (checked .claude/skills, .agents/skills, .github/skills, .codex/skills, .gemini/skills).";
      }
      const lines = skills.map(
        (s) => `- ${s.id} (${s.name}):\n    ${s.description}\n    Path: ${s.relPath}`
      );
      return `Found ${skills.length} workspace skill(s):\n\n${lines.join("\n\n")}\n\nCall read_skill(skill_id) to view complete instructions.`;
    },
  },
  {
    name: "read_skill",
    title: "Read Skill",
    description:
      "Read the full instruction markdown of a specific skill or one of its resource files.",
    capability: "read",
    inputSchema: {
      type: "object",
      required: ["skill_id"],
      properties: {
        skill_id: {
          type: "string",
          description: "The skill identifier (id or name returned by list_skills).",
        },
        resource_path: {
          type: "string",
          description:
            "Optional relative path inside the skill package (e.g. 'references/rules.md'). If omitted, reads the main SKILL.md.",
        },
      },
    },
    async run(args) {
      const skills = findSkillPackages();
      const target = skills.find(
        (s) => s.id === args.skill_id || s.name === args.skill_id
      );
      if (!target) {
        const available = skills.map((s) => s.id).join(", ");
        throw new Error(
          `Skill "${args.skill_id}" not found. Available skills: ${available || "(none)"}`
        );
      }

      let filePath = target.skillMd;
      if (args.resource_path) {
        const cleaned = path.normalize(args.resource_path).replace(/^(\.\.[\/\\])+/, "");
        filePath = path.join(target.skillDir, cleaned);
        // Security check: stay within target.skillDir. A relative() based check,
        // not startsWith(): a plain prefix compare would accept a sibling
        // directory whose name merely starts with the same text (skills vs skills-x).
        if (!scope.isInside(filePath, target.skillDir)) {
          throw new Error("Invalid resource path: must stay inside skill directory.");
        }
      }

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${args.resource_path || "SKILL.md"}`);
      }

      const content = fs.readFileSync(filePath, "utf8");
      return content;
    },
  },
];

module.exports = { TOOLS, findSkillPackages };

