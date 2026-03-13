import type { LLMMessage } from "../llm/types.js";
import { projectThinkingIntoPromptContent } from "../llm/thinking.js";
import { microCompact } from "./compaction.js";
import { normalizeHistory } from "./history-normalizer.js";

export interface PromptHistoryOptions {
  keepToolResults?: number;
  keepMedias?: number;
}

export function preparePromptHistory(
  messages: LLMMessage[],
  options: PromptHistoryOptions = {},
): LLMMessage[] {
  return projectPromptHistoryForProvider(microCompact(messages, options));
}

export function prepareCompactionHistory(
  messages: LLMMessage[],
  options: PromptHistoryOptions = {},
): { compactedMessages: LLMMessage[]; parkedMessages: LLMMessage[] } {
  const normalized = normalizeHistory(messages).messages;
  const { baseMessages, parkedMessages } = splitTrailingInFlightToolBatch(normalized);
  return {
    compactedMessages: microCompact(baseMessages, options),
    parkedMessages,
  };
}

function projectPromptHistoryForProvider(messages: LLMMessage[]): LLMMessage[] {
  return messages.map(projectThinkingIntoPromptContent);
}

function splitTrailingInFlightToolBatch(messages: LLMMessage[]): {
  baseMessages: LLMMessage[];
  parkedMessages: LLMMessage[];
} {
  if (messages.length === 0) {
    return { baseMessages: messages, parkedMessages: [] };
  }

  let toolStart = messages.length;
  while (toolStart > 0 && messages[toolStart - 1].role === "tool") {
    toolStart--;
  }

  const trailingTools = messages.slice(toolStart);
  if (trailingTools.length === 0) {
    return { baseMessages: messages, parkedMessages: [] };
  }

  const assistant = messages[toolStart - 1];
  if (
    assistant?.role !== "assistant" ||
    !assistant.toolCalls?.length ||
    !trailingTools.some((msg) => msg.toolStatus === "pending")
  ) {
    return { baseMessages: messages, parkedMessages: [] };
  }

  return {
    baseMessages: messages.slice(0, toolStart - 1),
    parkedMessages: [assistant, ...trailingTools],
  };
}
