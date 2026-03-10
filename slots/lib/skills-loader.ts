/**
 * SkillsLoader — 扫描 skills/*.md 文件，产出：
 *   - SkillMeta[]（供 read_skill 工具检索）
 *   - 单个 ContextSlot "skills"（AI 上下文中的技能摘要）
 *
 * 直接继承 BaseLoader，通过 scanFn()/fileWatchPattern() 虚方法声明 .md 策略，
 * 无需中间抽象层。scanSync 是本 loader 自己的同步扫描路径，供 slot 工厂调用。
 */

import { basename, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import type { ContextSlot } from "../../src/context/types.js";
import type { CapabilityDescriptor, PathManagerAPI } from "../../src/core/types.js";
import type { LoaderContext } from "../../src/loaders/types.js";
import { BaseLoader } from "../../src/loaders/base-loader.js";
import { flatFiles } from "../../src/loaders/scanner.js";
import type { ScanFn } from "../../src/loaders/scanner.js";

// ─── Types ───

interface MdFile { name: string; path: string }

export interface SkillMeta {
  name: string;
  description: string;
  globs: string[];
  filePath: string;
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

// ─── Loader ───

export class SkillsLoader extends BaseLoader<MdFile, SkillMeta> {
  // .md 平铺扫描
  protected override scanFn(): ScanFn { return flatFiles(); }
  protected override fileWatchPattern(): string { return "[^/]+\\.md"; }

  async importFactory(pathWithQuery: string): Promise<MdFile> {
    const path = pathWithQuery.replace(/\?[^?]*$/, "");
    return { name: basename(path, ".md"), path };
  }

  validateFactory(_: MdFile): boolean { return true; }

  createInstance(
    factory: MdFile,
    _ctx: LoaderContext,
    name: string,
    _descriptor: CapabilityDescriptor,
  ): SkillMeta {
    const result = this.parseSkill(name, factory.path);
    if (!result) throw new Error(`[SkillsLoader] missing 'name' frontmatter in "${factory.path}"`);
    return result;
  }

  onRegister(_name: string, _instance: SkillMeta): void {}
  onUnregister(_name: string, _instance: SkillMeta): void {}

  // ─── 同步扫描（供 slot 工厂直接调用）───

  scanSync(pm: PathManagerAPI, brainId: string): SkillMeta[] {
    const kind = "skills";
    const dirs = [
      pm.global().capabilityDir(kind),
      pm.bundle().capabilityDir(kind),
      pm.local(brainId).capabilityDir(kind),
    ];
    const map = new Map<string, SkillMeta>();
    for (const dir of dirs) {
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          const name = file.slice(0, -3);
          const skill = this.parseSkill(name, join(dir, file));
          if (skill) map.set(name, skill);
        }
      } catch { /* 目录不存在 */ }
    }
    return [...map.values()];
  }

  // ─── Slot 工厂辅助 ───

  createSummarySlot(pm: PathManagerAPI, brainId: string): ContextSlot {
    return {
      id: "skills",
      order: 40,
      priority: 7,
      content: () => {
        const skills = this.scanSync(pm, brainId);
        if (skills.length === 0) return "";
        const lines = ["## Available Skills"];
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

  // ─── Private ───

  private parseSkill(name: string, path: string): SkillMeta | null {
    try {
      const raw = readFileSync(path, "utf-8");
      const meta = extractFrontmatter(raw);
      if (!meta?.name) return null;
      return {
        name: String(meta.name),
        description: meta.description ? String(meta.description) : "",
        globs: Array.isArray(meta.globs) ? (meta.globs as string[]) : ["*"],
        filePath: path,
      };
    } catch { return null; }
  }
}
