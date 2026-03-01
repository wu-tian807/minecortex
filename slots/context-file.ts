import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SlotFactory, ContextSlot } from "../src/context/types.js";

const ROOT = process.cwd();
const MAX_TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 50;

function buildDirTree(dir: string, depth: number = 0, count = { n: 0 }): string[] {
  if (depth > MAX_TREE_DEPTH || count.n >= MAX_TREE_ENTRIES) return [];

  const lines: string[] = [];
  try {
    const entries = readdirSync(dir).sort();
    const indent = "  ".repeat(depth);
    for (const entry of entries) {
      if (count.n >= MAX_TREE_ENTRIES) {
        lines.push(`${indent}... (truncated)`);
        break;
      }
      if (entry.startsWith(".") || entry === "node_modules") continue;

      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          lines.push(`${indent}${entry}/`);
          count.n++;
          lines.push(...buildDirTree(fullPath, depth + 1, count));
        } else {
          lines.push(`${indent}${entry}`);
          count.n++;
        }
      } catch {
        // stat failed
      }
    }
  } catch {
    // readdir failed
  }
  return lines;
}

function buildFocusContent(targetPath: string): string {
  const parts: string[] = [];
  const rel = relative(ROOT, targetPath) || ".";
  parts.push(`## Focus: ${rel}`);

  // Try AGENTS.md first, then README.md
  let docContent = "";
  for (const name of ["AGENTS.md", "README.md"]) {
    try {
      docContent = readFileSync(join(targetPath, name), "utf-8");
      parts.push(`\n### ${name}\n${docContent}`);
      break;
    } catch {
      // not found
    }
  }

  // Directory tree
  const tree = buildDirTree(targetPath);
  if (tree.length > 0) {
    parts.push(`\n### Directory Structure\n\`\`\`\n${tree.join("\n")}\n\`\`\``);
  }

  return parts.join("\n");
}

const create: SlotFactory = (ctx): ContextSlot => {
  const defaultPath = join(ROOT, "brains", ctx.brainId);

  return {
    id: "context-file:current",
    kind: "dynamic",
    order: 60,
    priority: 5,
    content: () => buildFocusContent(defaultPath),
    version: 0,
  };
};

export default create;
export { buildFocusContent };
