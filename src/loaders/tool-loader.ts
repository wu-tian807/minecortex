/** @desc 扫描全局 + 脑内工具定义，按 brain.json 配置过滤并合并 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrainJson, ToolDefinition } from "../core/types.js";
import { applySelector } from "./subscription-loader.js";

const ROOT = process.cwd();

async function scanTools(dir: string): Promise<Map<string, ToolDefinition>> {
  const map = new Map<string, ToolDefinition>();
  try {
    const files = await readdir(dir);
    const tsFiles = files.filter((f) => f.endsWith(".ts"));
    for (const f of tsFiles) {
      const mod = await import(join(dir, f));
      const tool = mod.default as ToolDefinition;
      if (tool?.name) {
        map.set(tool.name, tool);
      }
    }
  } catch {
    // directory doesn't exist
  }
  return map;
}

export async function loadTools(
  brainId: string,
  brainConfig: BrainJson,
): Promise<ToolDefinition[]> {
  const globalTools = await scanTools(join(ROOT, "tools"));
  const localTools = await scanTools(join(ROOT, "brains", brainId, "tools"));

  // local overrides global (same name)
  const merged = new Map([...globalTools, ...localTools]);
  const enabled = applySelector([...merged.keys()], brainConfig.tools);
  return enabled.map((name) => merged.get(name)!).filter(Boolean);
}
