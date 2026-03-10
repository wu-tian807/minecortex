/**
 * scanner.ts — 能力文件发现与过滤。
 *
 * 核心抽象：ScanFn
 *   (source: CapabilitySource) → Promise<CapabilityDescriptor[]>
 *
 * 内置策略：
 *   flatFilesAndTags(ext)  — 平铺文件 + 子目录 tag，默认用于 .ts 代码文件
 *   flatFiles(ext)         — 仅平铺文件，用于 .md 内容文件
 *   scanDirs()             — 每个子目录 = 一个能力单元，用于目录型 skill 等
 *
 * 组合：
 *   combineScan(...fns)    — 多策略合并（用于同时扫描文件和目录的混合场景）
 *
 * FSWatcher 辅助：
 *   registerMdPatterns(watcher, kind, cb)  — 为指定 kind 注册三层 .md 文件 watch
 *
 * BaseLoader 通过 protected scanFn() 虚方法让子类选择策略，无需修改 discover()。
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FSWatcherAPI, FSChangeEvent } from "../core/types.js";
import type {
  CapabilityDescriptor,
  CapabilitySelector,
  CapabilitySource,
} from "../core/types.js";

// ─── ScanFn 类型 ───

export type ScanFn = (source: CapabilitySource) => Promise<CapabilityDescriptor[]>;

// ─── 内置扫描策略 ───

/**
 * 平铺文件 + tag 子目录扫描（默认 .ts）。
 * 目录结构：
 *   {dir}/{name}.ts
 *   {dir}/{tag}/{name}.ts  ← 子目录作为 tag
 */
export function flatFilesAndTags(ext: string = ".ts"): ScanFn {
  return async (source) => {
    const descriptors: CapabilityDescriptor[] = [];
    try {
      const entries = await readdir(source.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(ext)) {
          const name = entry.name.slice(0, -ext.length);
          descriptors.push({ name, exposedName: name, path: join(source.dir, entry.name) });
          continue;
        }
        if (!entry.isDirectory()) continue;
        const tag = entry.name;
        try {
          const taggedEntries = await readdir(join(source.dir, tag), { withFileTypes: true });
          for (const taggedEntry of taggedEntries) {
            if (!taggedEntry.isFile() || !taggedEntry.name.endsWith(ext)) continue;
            const name = taggedEntry.name.slice(0, -ext.length);
            descriptors.push({
              name, tag,
              exposedName: name,
              path: join(source.dir, tag, taggedEntry.name),
            });
          }
        } catch { /* tag dir doesn't exist */ }
      }
    } catch { /* source dir doesn't exist */ }
    return descriptors;
  };
}

/**
 * 仅平铺文件扫描，不进入子目录（适合 .md 等内容文件）。
 * 目录结构：
 *   {dir}/{name}.md
 */
export function flatFiles(ext: string = ".md"): ScanFn {
  return async (source) => {
    const descriptors: CapabilityDescriptor[] = [];
    try {
      const entries = await readdir(source.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
        const name = entry.name.slice(0, -ext.length);
        descriptors.push({ name, exposedName: name, path: join(source.dir, entry.name) });
      }
    } catch { /* source dir doesn't exist */ }
    return descriptors;
  };
}

/**
 * 目录型扫描：每个子目录 = 一个能力单元。
 * 适合未来的 skill-as-directory 结构：
 *   {dir}/{skillName}/         ← path = 目录本身
 *     README.md
 *     examples/
 *     ...
 *
 * importFactory 收到目录路径后自行决定如何读取内容。
 */
export function scanDirs(): ScanFn {
  return async (source) => {
    const descriptors: CapabilityDescriptor[] = [];
    try {
      const entries = await readdir(source.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        descriptors.push({
          name,
          exposedName: name,
          path: join(source.dir, name), // path = 目录本身
        });
      }
    } catch { /* source dir doesn't exist */ }
    return descriptors;
  };
}

/**
 * 组合多个扫描策略（结果合并，同名以后者覆盖前者）。
 * 用于同一目录下混合文件和子目录的场景。
 */
export function combineScan(...fns: ScanFn[]): ScanFn {
  return async (source) => {
    const merged = new Map<string, CapabilityDescriptor>();
    for (const fn of fns) {
      for (const d of await fn(source)) {
        merged.set(`${d.tag ?? ""}:${d.name}`, d);
      }
    }
    return [...merged.values()];
  };
}

// ─── discover ───

/**
 * 扫描所有 sources（后者覆盖前者），并解决 exposedName 冲突（多 source 同名 → 追加 @tag）。
 * 每个 descriptor 携带 sourceId，供 filterByCapability 做 bundle 层级过滤。
 * @param scan - 扫描策略函数，默认为 flatFilesAndTags(".ts")
 */
export async function discover(
  sources: CapabilitySource[],
  scan: ScanFn = flatFilesAndTags(),
): Promise<CapabilityDescriptor[]> {
  const preferred = new Map<string, CapabilityDescriptor>();
  for (const source of sources) {
    for (const entry of await scan(source)) {
      preferred.set(`${entry.tag ?? ""}:${entry.name}`, { ...entry, sourceId: source.id });
    }
  }

  const descriptors = [...preferred.values()];
  const nameCount = new Map<string, number>();
  for (const d of descriptors) nameCount.set(d.name, (nameCount.get(d.name) ?? 0) + 1);
  for (const d of descriptors) {
    d.exposedName = (nameCount.get(d.name) ?? 1) > 1 ? `${d.name}@${d.tag ?? "default"}` : d.name;
  }
  return descriptors;
}

// ─── filterByCapability ───

/**
 * Filters descriptors by a CapabilitySelector.
 *
 * Three source layers with independent rules:
 *
 *   local  (sourceId !== "global" && sourceId !== "bundle")
 *          → ALWAYS loaded. Brain's own directory, not gated by any field.
 *
 *   bundle (sourceId === "bundle")
 *          → controlled by selector.bundle ("all"|"none", default "none").
 *
 *   global (sourceId === "global")
 *          → controlled by selector.global ("all"|"none", default "none").
 *
 * After layer defaults, enable[] adds and disable[] removes individual items
 * across any layer (including local).
 *
 * Examples:
 *   { global:"none", bundle:"none" }  → local only          (standard default)
 *   { global:"none", bundle:"all"  }  → local + bundle
 *   { global:"all",  bundle:"none" }  → local + global
 *   { global:"all",  bundle:"all"  }  → all three layers
 *   { global:"none", bundle:"none", enable:["x"] } → local + explicitly named "x"
 */
export function filterByCapability(
  descriptors: CapabilityDescriptor[],
  selector: CapabilitySelector,
): CapabilityDescriptor[] {
  const selected = new Map<string, CapabilityDescriptor>();

  // Step 1: layer defaults
  for (const d of descriptors) {
    if (d.sourceId !== "global" && d.sourceId !== "bundle") {
      // local layer — always included
      selected.set(d.exposedName, d);
    } else if (d.sourceId === "bundle") {
      if ((selector.bundle ?? "none") === "all") selected.set(d.exposedName, d);
    } else {
      // global layer
      if ((selector.global ?? "none") === "all") selected.set(d.exposedName, d);
    }
  }

  // Step 2: explicit enable[] — adds from any layer regardless of defaults
  for (const token of selector.enable ?? []) {
    for (const d of resolveToken(token, descriptors)) selected.set(d.exposedName, d);
  }

  // Step 3: explicit disable[] — removes from any layer, including local
  for (const token of selector.disable ?? []) {
    for (const d of resolveToken(token, descriptors)) selected.delete(d.exposedName);
  }

  return [...selected.values()];
}

function resolveToken(token: string, descriptors: CapabilityDescriptor[]): CapabilityDescriptor[] {
  if (token.startsWith("#")) {
    const tag = token.slice(1);
    return descriptors.filter((d) => d.tag === tag);
  }

  const atIndex = token.lastIndexOf("@");
  if (atIndex > 0) {
    const name = token.slice(0, atIndex);
    const tag = token.slice(atIndex + 1);
    return descriptors.filter((d) => d.name === name && d.tag === tag);
  }

  const matches = descriptors.filter((d) => d.name === token);
  if (matches.length === 1) return matches;
  if (matches.length > 1) {
    console.warn(`[scanner] ambiguous bare capability "${token}", use "name@tag" instead`);
  }
  return [];
}

// ─── FSWatcher 辅助 ───

/**
 * 为指定 kind 在三层目录上注册 .md 文件 watch pattern。
 * 供实现了 scanSync 的内容型 loader（directives、skills 等）在 registerWatchers
 * 中调用，无需各自重复写层级 regex。
 *
 *   global layer : {kind}/*.md
 *   bundle layer : bundle/{kind}/*.md
 *   local  layer : bundle/brains/{brainId}/{kind}/*.md
 */
export function registerMdPatterns(
  watcher: FSWatcherAPI,
  kind: string,
  onChanged: (event: FSChangeEvent) => void,
): void {
  watcher.register(new RegExp(`^${kind}/[^/]+\\.md$`), onChanged);
  watcher.register(new RegExp(`^bundle/${kind}/[^/]+\\.md$`), onChanged);
  watcher.register(new RegExp(`^bundle/brains/[^/]+/${kind}/[^/]+\\.md$`), onChanged);
}
