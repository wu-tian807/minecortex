import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotFactory, ContextSlot } from "../src/context/types.js";

const ROOT = process.cwd();
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const DEFAULT_ORDER = 20;
const DEFAULT_PRIORITY = 9;

interface FrontMatter {
  order?: number;
}

function parseFrontMatter(raw: string): { meta: FrontMatter; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { meta: {}, body: raw };

  const meta: FrontMatter = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    const k = key?.trim();
    const v = rest.join(":").trim();
    if (k === "order" && v) meta.order = Number(v);
  }

  return { meta, body: raw.slice(match[0].length) };
}

function scanMdFiles(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const name = f.replace(/\.md$/, "");
      map.set(name, join(dir, f));
    }
  } catch {
    // directory doesn't exist
  }
  return map;
}

function readMeta(filePath: string): FrontMatter {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseFrontMatter(raw).meta;
  } catch {
    return {};
  }
}

function stripFrontMatter(raw: string): string {
  return parseFrontMatter(raw).body;
}

const create: SlotFactory = (ctx): ContextSlot[] => {
  const globalDir = join(ROOT, "directives");
  const localDir = join(ROOT, "brains", ctx.brainId, "directives");

  const globalFiles = scanMdFiles(globalDir);
  const localFiles = scanMdFiles(localDir);

  const merged = new Map([...globalFiles, ...localFiles]);

  const entries = [...merged.entries()];
  return entries.map(([name, filePath], i): ContextSlot => {
    const meta = readMeta(filePath);
    return {
      id: `directive:${name}`,
      order: meta.order ?? DEFAULT_ORDER + i,
      priority: DEFAULT_PRIORITY,
      content: () => {
        try {
          return stripFrontMatter(readFileSync(filePath, "utf-8"));
        } catch {
          return "";
        }
      },
      version: 0,
    };
  });
};

export default create;
