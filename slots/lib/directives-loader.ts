/**
 * DirectivesLoader — 扫描 directives/*.md 文件，每个文件产出一个 ContextSlot。
 *
 * 直接继承 BaseLoader，通过 scanFn()/fileWatchPattern() 虚方法声明 .md 策略。
 * scanSync 是本 loader 自己的同步扫描路径，供 slot 工厂调用。
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

// ─── Frontmatter / content helpers ───

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

function buildSlots(name: string, path: string): ContextSlot[] {
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

// ─── Loader ───

export class DirectivesLoader extends BaseLoader<MdFile, ContextSlot[]> {
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
  ): ContextSlot[] {
    return buildSlots(name, factory.path);
  }

  onRegister(_name: string, _instance: ContextSlot[]): void {}
  onUnregister(_name: string, _instance: ContextSlot[]): void {}

  // ─── 同步扫描（供 slot 工厂直接调用）───

  scanSync(pm: PathManagerAPI, brainId: string): ContextSlot[][] {
    const kind = "directives";
    const dirs = [
      pm.global().capabilityDir(kind),
      pm.bundle().capabilityDir(kind),
      pm.local(brainId).capabilityDir(kind),
    ];
    const map = new Map<string, ContextSlot[]>();
    for (const dir of dirs) {
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          const name = file.slice(0, -3);
          map.set(name, buildSlots(name, join(dir, file)));
        }
      } catch { /* 目录不存在 */ }
    }
    return [...map.values()];
  }
}
