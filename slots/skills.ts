import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotFactory, ContextSlot } from "../src/context/types.js";

const ROOT = process.cwd();

interface SkillMeta {
  name: string;
  description: string;
  globs: string[];
  filePath: string;
}

function extractFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result: Record<string, any> = {};
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (val.startsWith("[")) {
      // simple array: ["*.ts", "*.tsx"]
      result[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      result[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

function scanSkills(dir: string): Map<string, SkillMeta> {
  const map = new Map<string, SkillMeta>();
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const filePath = join(dir, f);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const meta = extractFrontmatter(raw);
        if (!meta?.name) continue;
        map.set(meta.name, {
          name: meta.name,
          description: meta.description ?? "",
          globs: meta.globs ?? ["*"],
          filePath,
        });
      } catch {
        // unreadable
      }
    }
  } catch {
    // directory doesn't exist
  }
  return map;
}

const create: SlotFactory = (ctx): ContextSlot => {
  const globalDir = join(ROOT, "skills");
  const localDir = join(ROOT, "brains", ctx.brainId, "skills");

  return {
    id: "skills",
    order: 40,
    priority: 7,
    content: () => {
      const globalSkills = scanSkills(globalDir);
      const localSkills = scanSkills(localDir);
      const merged = new Map([...globalSkills, ...localSkills]);

      if (merged.size === 0) return "";
      const lines: string[] = ["## Available Skills"];
      for (const skill of merged.values()) {
        lines.push(
          `- ${skill.name}: ${skill.description} (globs: ${skill.globs.join(", ")})`,
        );
      }
      lines.push(
        "",
        'IMPORTANT: When a task matches a skill, you MUST call read_skill first to get detailed instructions before proceeding.',
      );
      return lines.join("\n");
    },
    version: 0,
  };
};

export default create;
