/**
 * DirectivesLoader — 扫描 directives/*.md 文件，每个文件产出一个 ContextSlot。
 *
 * 位置：slots/lib/（能力包层，非框架层）
 * 基类：AbstractContentLoader（src/loaders/content-loader.ts）
 *
 * 激活机制：
 *  - 当前：由 slots/directives.ts 工厂调用 scanSync()，工厂由 SlotLoader 加载。
 *  - 未来：可被 Scheduler 直接实例化，作为独立 loader 使用。
 */

import { readFileSync } from "node:fs";
import type { ContextSlot } from "../../src/context/types.js";
import { AbstractContentLoader } from "../../src/loaders/content-loader.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const DEFAULT_ORDER = 20;
const DEFAULT_PRIORITY = 9;

function parseFrontMatter(raw: string): { order?: number } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return {};
  const meta: { order?: number } = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    const k = key?.trim();
    const v = rest.join(":").trim();
    if (k === "order" && v) meta.order = Number(v);
  }
  return meta;
}

function stripFrontMatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, "");
}

export class DirectivesLoader extends AbstractContentLoader<ContextSlot[]> {
  protected kindName(): string {
    return "directives";
  }

  /**
   * 从单个 directive .md 文件构建 ContextSlot[]（通常只有一个 slot）。
   * content() 采用懒加载：每次调用时重新读文件，确保热更新后内容最新。
   */
  protected buildFromFile(name: string, path: string): ContextSlot[] {
    const raw = readFileSync(path, "utf-8");
    const meta = parseFrontMatter(raw);
    return [{
      id: `directive:${name}`,
      order: meta.order ?? DEFAULT_ORDER,
      priority: DEFAULT_PRIORITY,
      content: () => {
        try { return stripFrontMatter(readFileSync(path, "utf-8")); }
        catch { return ""; }
      },
      version: 0,
    }];
  }
}
