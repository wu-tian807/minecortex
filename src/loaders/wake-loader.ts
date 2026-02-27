/** @desc 加载 brains/<id>/wake.ts 唤醒策略，不存在则返回默认策略 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { WakePolicy } from "../core/types.js";

const ROOT = process.cwd();

const DEFAULT_POLICY: WakePolicy = {
  shouldWake: () => true,
};

export async function loadWakePolicy(brainId: string): Promise<WakePolicy> {
  const wakePath = join(ROOT, "brains", brainId, "wake.ts");
  try {
    await access(wakePath);
    const mod = await import(wakePath);
    const policy = mod.default as WakePolicy;
    if (typeof policy.shouldWake !== "function") {
      console.warn(`[wake-loader] brains/${brainId}/wake.ts 缺少 shouldWake(), 使用默认策略`);
      return DEFAULT_POLICY;
    }
    console.log(`[wake-loader] brains/${brainId}/wake.ts 已加载`);
    return policy;
  } catch {
    return DEFAULT_POLICY;
  }
}
