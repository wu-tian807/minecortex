import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotFactory, ContextSlot } from "../src/context/types.js";

const ROOT = process.cwd();

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

const create: SlotFactory = (ctx): ContextSlot[] => {
  const globalDir = join(ROOT, "directives");
  const localDir = join(ROOT, "brains", ctx.brainId, "directives");

  const globalFiles = scanMdFiles(globalDir);
  const localFiles = scanMdFiles(localDir);

  // local overrides global (same filename)
  const merged = new Map([...globalFiles, ...localFiles]);

  const entries = [...merged.entries()];
  return entries.map(([name, filePath], i): ContextSlot => ({
    id: `directive:${name}`,
    kind: "system",
    order: 20 + i,
    priority: 9,
    content: () => {
      try {
        return readFileSync(filePath, "utf-8");
      } catch {
        return "";
      }
    },
    version: 0,
  }));
};

export default create;
