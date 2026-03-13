import type { LLMMessage } from "../llm/types.js";
import {
  buildPersistentToolRepair,
  normalizeToolTimeline,
  type NormalizedToolTimeline,
  type PersistentToolRepair,
} from "./tool-normalizer.js";

export type { NormalizedToolTimeline, PersistentToolRepair };

/**
 * History normalization entrypoint.
 * Today this delegates to the tool timeline normalizer; future message/media
 * normalizers can be chained here without changing higher-level callers.
 */
export function normalizeHistory(messages: LLMMessage[]): NormalizedToolTimeline {
  return normalizeToolTimeline(messages);
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
