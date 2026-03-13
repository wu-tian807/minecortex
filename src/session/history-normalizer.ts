import type { LLMMessage } from "../llm/types.js";
import {
  normalizeThinkingTimeline,
  type NormalizedThinkingTimeline,
} from "./thinking-normalizer.js";
import {
  buildPersistentToolRepair,
  normalizeToolTimeline,
  type NormalizedToolTimeline,
  type PersistentToolRepair,
} from "./tool-normalizer.js";

export type {
  NormalizedThinkingTimeline,
  NormalizedToolTimeline,
  PersistentToolRepair,
};

/**
 * History normalization entrypoint.
 * Today this delegates to the tool timeline normalizer; future message/media
 * normalizers can be chained here without changing higher-level callers.
 */
export function normalizeHistory(messages: LLMMessage[]): NormalizedToolTimeline {
  const thinkingNormalized = normalizeThinkingTimeline(messages);
  const toolNormalized = normalizeToolTimeline(thinkingNormalized.messages);
  return {
    ...toolNormalized,
    changed: thinkingNormalized.changed || toolNormalized.changed,
  };
}

/**
 * Persistent repair entrypoint. This is intentionally explicit and separate from
 * read-path normalization so callers can choose when disk rewrites are allowed.
 */
export function buildPersistentHistoryRepair(messages: LLMMessage[]): PersistentToolRepair {
  return buildPersistentToolRepair(messages);
}

// Backward-compatible exports while call sites migrate to the orchestrator names.
export { normalizeToolTimeline, buildPersistentToolRepair };
