import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import type { ContextSlot } from "../../src/context/types.js";
import type { PathManagerAPI } from "../../src/core/types.js";
import type { SlotWatchPattern } from "../../src/loaders/types.js";

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

function directiveDirs(pm: PathManagerAPI, brainId: string): string[] {
  return [
    join(pm.global().root(), "directives"),
    join(pm.bundle().root(), "directives"),
    join(pm.local(brainId).root(), "directives"),
  ];
}

export function buildDirectiveWatchPatterns(pm: PathManagerAPI, brainId: string): SlotWatchPattern[] {
  return directiveDirs(pm, brainId).map((dir) => ({
    pattern: new RegExp(`^${escapeRegex(relativeFromRoot(pm.root(), dir))}/[^/]+\\.md$`),
    action: "reloadAll",
  }));
}

export function createDirectiveSlots(pm: PathManagerAPI, brainId: string): ContextSlot[] {
  const map = new Map<string, ContextSlot[]>();
  for (const dir of directiveDirs(pm, brainId)) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const name = file.slice(0, -3);
        map.set(name, buildSlots(name, join(dir, file)));
      }
    } catch { /* directory doesn't exist */ }
  }
  return [...map.values()].flat();
}

function relativeFromRoot(root: string, dir: string): string {
  return dir.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
