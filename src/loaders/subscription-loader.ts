/** @desc 扫描全局 + 脑内订阅源，按 brain.json 配置过滤，返回激活列表 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrainJson, CapabilitySelector, EventSource } from "../core/types.js";

const ROOT = process.cwd();

function applySelector(
  available: string[],
  selector: CapabilitySelector | undefined,
): string[] {
  if (!selector) return [];
  if (selector.default === "all") {
    const disabled = new Set(selector.disable ?? []);
    return available.filter((n) => !disabled.has(n));
  }
  return selector.enable ?? [];
}

async function scanSources(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const files = await readdir(dir);
    for (const f of files) {
      if (f.endsWith(".ts")) {
        map.set(f.replace(/\.ts$/, ""), join(dir, f));
      }
    }
  } catch {
    // directory doesn't exist — skip
  }
  return map;
}

export async function loadSubscriptions(
  brainId: string,
  brainConfig: BrainJson,
): Promise<EventSource[]> {
  const globalSources = await scanSources(join(ROOT, "subscriptions"));
  const localSources = await scanSources(
    join(ROOT, "brains", brainId, "subscriptions"),
  );

  // local overrides global
  const merged = new Map([...globalSources, ...localSources]);
  const enabled = applySelector(
    [...merged.keys()],
    brainConfig.subscriptions,
  );

  const sources: EventSource[] = [];
  for (const name of enabled) {
    const path = merged.get(name);
    if (!path) continue;
    const mod = await import(path);
    sources.push(mod.default as EventSource);
  }
  return sources;
}

export { applySelector };
