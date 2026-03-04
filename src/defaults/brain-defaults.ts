/** @desc Centralized default values for BrainJson fields */

import type { BrainJson, CapabilitySelector } from "../core/types.js";

/** Default capability selector: enable all from global */
export const DEFAULT_SELECTOR_ALL: CapabilitySelector = { global: "all" };

/** Default capability selector: disable all from global */
export const DEFAULT_SELECTOR_NONE: CapabilitySelector = { global: "none" };

/** Centralized default values for BrainJson */
export const BRAIN_DEFAULTS = {
  /** 事件合并窗口（毫秒） */
  coalesceMs: 300,

  /** 单轮最大 LLM 调用次数 */
  maxIterations: 200,

  /** Session 压缩配置 */
  session: {
    keepToolResults: 8,
    keepMedias: 2,
  },

  /** 时区 */
  timezone: "Asia/Shanghai",

  /** 能力选择器默认值 */
  subscriptions: DEFAULT_SELECTOR_NONE,
  tools: DEFAULT_SELECTOR_ALL,
  slots: DEFAULT_SELECTOR_ALL,
} as const;

/** Resolve a BrainJson field with default fallback */
export function resolveBrainConfig<K extends keyof typeof BRAIN_DEFAULTS>(
  brainJson: BrainJson,
  key: K,
): (typeof BRAIN_DEFAULTS)[K] {
  const value = brainJson[key as keyof BrainJson];
  if (value !== undefined) return value as (typeof BRAIN_DEFAULTS)[K];
  return BRAIN_DEFAULTS[key];
}
