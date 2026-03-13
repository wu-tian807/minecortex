import type { LLMMessage } from "../llm/types.js";
import {
  isThinkingOnlyAssistantMessage,
} from "../llm/thinking.js";

export interface NormalizedThinkingTimeline {
  messages: LLMMessage[];
  changed: boolean;
}

export function normalizeThinkingTimeline(messages: LLMMessage[]): NormalizedThinkingTimeline {
  const normalized: LLMMessage[] = [];
  let changed = false;

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];

    const next = i + 1 < messages.length ? messages[i + 1] : null;
    if (next && canMergeIntoNextAssistant(current, next)) {
      normalized.push({
        ...next,
        thinking: current.thinking,
        thinkingSignature: current.thinkingSignature ?? next.thinkingSignature,
      });
      changed = true;
      i++;
      continue;
    }

    normalized.push(current);
  }

  return { messages: normalized, changed };
}

function canMergeIntoNextAssistant(current: LLMMessage, next: LLMMessage): boolean {
  return (
    isThinkingOnlyAssistantMessage(current) &&
    next.role === "assistant" &&
    !next.thinking?.trim()
  );
}
