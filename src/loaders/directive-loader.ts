/** @desc 扫描 directives/ 加载指令模块 (.ts 配置 + .md 内容), 按 order 排序, condition 过滤 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrainJson,
  DirectiveConfig,
  DirectiveContext,
  LoadedDirective,
} from "../core/types.js";
import { applySelector } from "./subscription-loader.js";

const ROOT = process.cwd();

async function scanDirectives(dir: string): Promise<Map<string, { configPath: string; mdPath: string }>> {
  const map = new Map<string, { configPath: string; mdPath: string }>();
  try {
    const files = await readdir(dir);
    const tsFiles = files.filter((f) => f.endsWith(".ts"));
    for (const f of tsFiles) {
      const name = f.replace(/\.ts$/, "");
      const mdFile = `${name}.md`;
      if (files.includes(mdFile)) {
        map.set(name, {
          configPath: join(dir, f),
          mdPath: join(dir, mdFile),
        });
      }
    }
  } catch {
    // directory doesn't exist
  }
  return map;
}

function renderTemplate(content: string, variables: Record<string, string>): string {
  return content.replace(/\$\{(\w+)\}/g, (_, key) => variables[key] ?? "");
}

export async function loadDirectives(
  brainId: string,
  brainConfig: BrainJson,
  ctx: DirectiveContext,
  variables: Record<string, string>,
): Promise<string> {
  const globalDirs = await scanDirectives(join(ROOT, "directives"));
  const localDirs = await scanDirectives(join(ROOT, "brains", brainId, "directives"));

  // local overrides global (same name)
  const merged = new Map([...globalDirs, ...localDirs]);

  // apply brain.json selector
  const enabled = applySelector([...merged.keys()], brainConfig.directives);
  if (enabled.length === 0) return "";

  // load configs and content
  const loaded: LoadedDirective[] = [];
  for (const name of enabled) {
    const paths = merged.get(name);
    if (!paths) continue;
    try {
      const mod = await import(paths.configPath);
      const config: DirectiveConfig = mod.directive ?? mod.default;
      if (!config?.name) continue;

      // check condition
      if (config.condition && !config.condition(ctx)) continue;

      const rawContent = await readFile(paths.mdPath, "utf-8");
      const content = renderTemplate(rawContent, variables);
      loaded.push({ config, content });
    } catch (err) {
      console.warn(`[directive-loader] 加载 ${name} 失败:`, err);
    }
  }

  // sort by order
  loaded.sort((a, b) => a.config.order - b.config.order);

  return loaded.map((d) => d.content).join("\n\n");
}
