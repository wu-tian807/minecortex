import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import type { ContextSlot } from "../../src/context/types.js";
import type { PathManagerAPI } from "../../src/core/types.js";

export interface SkillMeta {
  name: string;
  description: string;
  globs: string[];
  filePath: string;
  content: string;
}

// ─── Frontmatter parser ───

function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    result[key] = val.startsWith("[")
      ? val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""))
      : val.replace(/^["']|["']$/g, "");
  }
  return result;
}

function skillDirs(pm: PathManagerAPI, brainId: string): string[] {
  return [
    join(pm.global().root(), "skills"),
    join(pm.bundle().root(), "skills"),
    join(pm.local(brainId).root(), "skills"),
  ];
}

export function scanSkills(pm: PathManagerAPI, brainId: string): SkillMeta[] {
  const map = new Map<string, SkillMeta>();
  for (const dir of skillDirs(pm, brainId)) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const key = file.slice(0, -3);
        const skill = parseSkill(join(dir, file));
        if (skill) map.set(key, skill);
      }
    } catch { /* directory doesn't exist */ }
  }
  return [...map.values()];
}

export function readSkillByName(pm: PathManagerAPI, brainId: string, name: string): string | null {
  return scanSkills(pm, brainId).find((skill) => skill.name === name)?.content ?? null;
}

export function createSkillsSummarySlot(pm: PathManagerAPI, brainId: string): ContextSlot {
  return {
    id: "skills",
    order: 40,
    priority: 7,
    content: () => {
      const skills = scanSkills(pm, brainId);
      if (skills.length === 0) return "";
      const lines = ["## Available Skills"];
      for (const skill of skills) {
        lines.push(`- ${skill.name}: ${skill.description} (globs: ${skill.globs.join(", ")})`);
      }
      lines.push(
        "",
        "IMPORTANT: When a task matches a skill, you MUST call read_skill first to get detailed instructions before proceeding.",
      );
      return lines.join("\n");
    },
    version: 0,
  };
}

function parseSkill(path: string): SkillMeta | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const meta = extractFrontmatter(raw);
    if (!meta?.name) return null;
    return {
      name: String(meta.name),
      description: meta.description ? String(meta.description) : "",
      globs: Array.isArray(meta.globs) ? (meta.globs as string[]) : ["*"],
      filePath: path,
      content: raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim(),
    };
  } catch {
    return null;
  }
}
