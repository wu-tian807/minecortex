import type { LLMMessage } from "../llm/types.js";
import { microCompact } from "./compaction.js";
import { repairToolPairing } from "./history-normalizer.js";

export interface PromptHistoryOptions {
  keepToolResults?: number;
  keepMedias?: number;
}

export function preparePromptHistory(
  messages: LLMMessage[],
  options: PromptHistoryOptions = {},
): LLMMessage[] {
  return microCompact(repairToolPairing(messages), options);
}

export function compactPromptHistory(
  messages: LLMMessage[],
  options: PromptHistoryOptions = {},
): LLMMessage[] {
  return microCompact(messages, options);
}
