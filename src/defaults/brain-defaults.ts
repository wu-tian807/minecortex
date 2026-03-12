/** @desc Centralized default values for BrainJson fields */

import type { BrainJson, CapabilitySelector } from "../core/types.js";

/**
 * Load everything from all three layers.
 */
export const DEFAULT_SELECTOR_ALL: CapabilitySelector = { global: "all", bundle: "all" };

/**
 * Load only from the brain's local layer (global and bundle both off).
 * This is the standard default: a brain starts isolated and opts in to
 * shared/framework capabilities explicitly via enable[] or by setting
 * global/bundle to "all".
 */
export const DEFAULT_SELECTOR_LOCAL_ONLY: CapabilitySelector = { global: "none", bundle: "none" };


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

  /** 默认工作目录（相对路径以 .home 为基准） */
  defaultDir: ".",

  /**
   * Capability selector defaults — local layer always loads unconditionally.
   * global and bundle are both "none" so a brain without an explicit selector
   * in brain.json gets only its own local capabilities.
   */
  subscriptions: DEFAULT_SELECTOR_LOCAL_ONLY,
  tools: DEFAULT_SELECTOR_LOCAL_ONLY,
  slots: DEFAULT_SELECTOR_LOCAL_ONLY,
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
