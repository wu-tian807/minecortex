import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../src/core/types.js";

const ROOT = process.cwd();

function findSkillFile(name: string, brainId: string): string | null {
  const dirs = [
    join(ROOT, "brains", brainId, "skills"),
    join(ROOT, "skills"),
  ];

  for (const dir of dirs) {
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const filePath = join(dir, f);
        const raw = readFileSync(filePath, "utf-8");
        const match = raw.match(/^---\n[\s\S]*?name\s*:\s*(.+)\n[\s\S]*?\n---/);
        if (match && match[1].trim().replace(/^["']|["']$/g, "") === name) {
          return filePath;
        }
      }
    } catch {
      // directory doesn't exist
    }
  }
  return null;
}

export default {
  name: "read_skill",
  description:
    "Read the full content of a skill by name. Use this after seeing the skills summary to get detailed instructions.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The skill name as shown in the Available Skills list",
      },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = String(args.name);
    const skillPath = findSkillFile(name, ctx.brainId);
    if (!skillPath) {
      return `Skill "${name}" not found.`;
    }
    const raw = readFileSync(skillPath, "utf-8");
    const stripped = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    return stripped.trim();
  },
} satisfies ToolDefinition;
