/**
 * SkillsLoader — 扫描 skills/*.md 文件，产出：
 *   - SkillMeta[]（供 read_skill 工具检索）
 *   - 单个 ContextSlot "skills"（AI 上下文中的技能摘要）
 *
 * 位置：slots/lib/（能力包层，非框架层）
 * 基类：AbstractContentLoader（src/loaders/content-loader.ts）
 *
 * 激活机制：
 *  - 当前：由 slots/skills.ts 工厂调用 createSummarySlot()，工厂由 SlotLoader 加载。
 *  - 未来：可被 Scheduler 直接实例化，作为独立 loader 使用。
 */

import { readFileSync } from "node:fs";
import type { ContextSlot } from "../../src/context/types.js";
import type { PathManagerAPI } from "../../src/core/types.js";
import { AbstractContentLoader } from "../../src/loaders/content-loader.js";

export interface SkillMeta {
  name: string;
  description: string;
  globs: string[];
  filePath: string;
}

function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (val.startsWith("[")) {
      result[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      result[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

export class SkillsLoader extends AbstractContentLoader<SkillMeta> {
  protected kindName(): string {
    return "skills";
  }

  /**
   * 从单个 skill .md 文件解析出 SkillMeta。
   * frontmatter 中必须有 name 字段，否则跳过（返回 null）。
   */
  protected buildFromFile(_name: string, path: string): SkillMeta | null {
    const raw = readFileSync(path, "utf-8");
    const meta = extractFrontmatter(raw);
    if (!meta?.name) return null;
    return {
      name: String(meta.name),
      description: meta.description ? String(meta.description) : "",
      globs: Array.isArray(meta.globs) ? (meta.globs as string[]) : ["*"],
      filePath: path,
    };
  }

  /**
   * 创建 "skills" ContextSlot（上下文中的技能摘要列表）。
   * content() 懒加载：每次调用时重新扫描 global + local 两层。
   */
  createSummarySlot(pm: PathManagerAPI, brainId: string): ContextSlot {
    return {
      id: "skills",
      order: 40,
      priority: 7,
      content: () => {
        const skills = this.scanSync(pm, brainId);
        if (skills.length === 0) return "";
        const lines: string[] = ["## Available Skills"];
        for (const s of skills) {
          lines.push(`- ${s.name}: ${s.description} (globs: ${s.globs.join(", ")})`);
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
}
