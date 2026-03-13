import type { LLMMessage } from "../llm/types.js";
import { createSyntheticToolResult, isTerminalToolMessage } from "./tool-lifecycle.js";

/**
 * Repair tool call / tool result pairing issues in message order:
 * - Drop orphaned / duplicate / pending-only tool messages from replay
 * - Keep terminal tool results bound to the immediately preceding assistant tool batch
 * - Preserve in-flight pending tool calls instead of treating them as broken
 * - Add synthetic error results only for truly missing tool calls in that batch
 */
export function repairToolPairing(messages: LLMMessage[]): LLMMessage[] {
  const result: LLMMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "tool") {
      continue;
    }

    result.push(msg);

    if (!msg.toolCalls?.length) {
      continue;
    }

    const bestById = new Map<string, LLMMessage>();
    let cursor = i + 1;

    while (cursor < messages.length && messages[cursor].role === "tool") {
      const toolMsg = messages[cursor];
      const callId = toolMsg.toolCallId;
      if (callId) {
        const normalized = {
          ...toolMsg,
          toolName: toolMsg.toolName ?? msg.toolCalls.find((tc) => tc.id === callId)?.name,
        };
        const current = bestById.get(callId);
        if (!current || compareToolMessagePriority(normalized, current) > 0) {
          bestById.set(callId, normalized);
        }
      }
      cursor++;
    }

    for (const tc of msg.toolCalls) {
      const toolMsg = bestById.get(tc.id);
      if (toolMsg) {
        result.push(toolMsg);
      } else {
        // No pending and no terminal result means the session was interrupted
        // after the assistant emitted tool calls but before lifecycle logging.
        result.push(createSyntheticToolResult(tc));
      }
    }

    i = cursor - 1;
  }

  return result;
}

function compareToolMessagePriority(a: LLMMessage, b: LLMMessage): number {
  return toolMessagePriority(a) - toolMessagePriority(b);
}

function toolMessagePriority(msg: LLMMessage): number {
  if (msg.role !== "tool") return -1;
  if (msg.toolStatus === "completed" || msg.toolStatus === "failed") {
    return 3;
  }
  if (msg.toolStatus === "synthetic") {
    return 2;
  }
  if (msg.toolStatus === "pending") {
    return 1;
  }
  if (isTerminalToolMessage(msg)) {
    return 3;
  }
  return 0;
}
