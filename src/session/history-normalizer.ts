import type { LLMMessage } from "../llm/types.js";
import { createSyntheticToolResult, isTerminalToolMessage } from "./tool-lifecycle.js";

/**
 * Repair tool call / tool result pairing issues in message order:
 * - Drop orphaned / duplicate / pending-only tool messages from replay
 * - Keep terminal tool results bound to the immediately preceding assistant tool batch
 * - Add synthetic error results for unresolved tool calls in that batch
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

    const terminalById = new Map<string, LLMMessage>();
    let cursor = i + 1;

    while (cursor < messages.length && messages[cursor].role === "tool") {
      const toolMsg = messages[cursor];
      const callId = toolMsg.toolCallId;
      if (callId && !terminalById.has(callId) && isTerminalToolMessage(toolMsg)) {
        terminalById.set(callId, {
          ...toolMsg,
          toolName: toolMsg.toolName ?? msg.toolCalls.find((tc) => tc.id === callId)?.name,
        });
      }
      cursor++;
    }

    for (const tc of msg.toolCalls) {
      const terminal = terminalById.get(tc.id);
      if (terminal) {
        result.push(terminal);
      } else {
        result.push(createSyntheticToolResult(tc));
      }
    }

    i = cursor - 1;
  }

  return result;
}
