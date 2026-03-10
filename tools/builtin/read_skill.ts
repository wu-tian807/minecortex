import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../../src/core/types.js";

function findSkill(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(dir, file);
        const raw = readFileSync(filePath, "utf-8");
        const match = raw.match(/^---\n[\s\S]*?name\s*:\s*(.+)\n[\s\S]*?\n---/);
        if (match && match[1].trim().replace(/^["']|["']$/g, "") === name) {
          return filePath;
        }
      }
    } catch { /* directory doesn't exist */ }
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
    // local 优先于 global（与 SkillsLoader 语义一致）
    const dirs = [
      ctx.pathManager.local(ctx.brainId).extraDir("skills"),
      ctx.pathManager.global().extraDir("skills"),
    ];
    const skillPath = findSkill(name, dirs);
    if (!skillPath) return `Skill "${name}" not found.`;
    const raw = readFileSync(skillPath, "utf-8");
    return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  },
} satisfies ToolDefinition;
