import type { ContentPart } from "../core/types.js";
import type { LLMMessage, LLMToolCall } from "../llm/types.js";

export interface ToolLifecycleSink {
  appendAssistantTurn(msg: LLMMessage): Promise<void>;
  appendToolPendings(toolCalls: LLMToolCall[]): Promise<void>;
  appendToolResult(toolCall: LLMToolCall, result: unknown): Promise<void>;
}

export interface NormalizedToolTimeline {
  messages: LLMMessage[];
  changed: boolean;
  hasInterruptedToolCalls: boolean;
}

export interface PersistentToolRepair {
  messages: LLMMessage[];
  changed: boolean;
  needsRepair: boolean;
}

export function isToolErrorResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

export function isTerminalToolMessage(msg: LLMMessage): boolean {
  return msg.role === "tool" && msg.toolStatus !== "pending";
}

export function createPendingToolMessage(toolCall: LLMToolCall): LLMMessage {
  return {
    role: "tool",
    content: `[Pending: ${toolCall.name}]`,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: "pending",
    ts: Date.now(),
  };
}

export function createPendingToolMessages(toolCalls: LLMToolCall[]): LLMMessage[] {
  return toolCalls.map(createPendingToolMessage);
}

export function createToolResultMessage(toolCall: LLMToolCall, result: unknown): LLMMessage {
  const content: string | ContentPart[] =
    isContentPartArray(result) ? result
    : typeof result === "string" ? result
    : JSON.stringify(result);
  return {
    role: "tool",
    content,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: isToolErrorResult(result) ? "failed" : "completed",
    ts: Date.now(),
  };
}

function isContentPartArray(v: unknown): v is ContentPart[] {
  return Array.isArray(v) && v.length > 0 && typeof (v as any[])[0]?.type === "string";
}

export function createSyntheticToolResult(
  toolCall: LLMToolCall,
  reason = `[Error: tool call "${toolCall.name}" was interrupted — no result available]`,
): LLMMessage {
  return {
    role: "tool",
    content: reason,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: "synthetic",
  };
}

export function createInterruptedToolResult(
  toolCall: LLMToolCall,
  reason = `[Interrupted: tool call "${toolCall.name}" did not produce a result before the conversation moved on]`,
): LLMMessage {
  return {
    role: "tool",
    content: reason,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: "interrupted",
  };
}

export function createInMemoryToolLifecycle(history: LLMMessage[]): ToolLifecycleSink {
  return {
    async appendAssistantTurn(msg: LLMMessage): Promise<void> {
      history.push(msg);
    },
    async appendToolPendings(toolCalls: LLMToolCall[]): Promise<void> {
      history.push(...createPendingToolMessages(toolCalls));
    },
    async appendToolResult(toolCall: LLMToolCall, result: unknown): Promise<void> {
      history.push(createToolResultMessage(toolCall, result));
    },
  };
}

/**
 * Normalize tool call / tool result pairing in memory:
 * - Drop raw tool ledger duplicates from replay
 * - Route each tool call to its best visible state
 * - Keep live in-flight calls as pending
 * - Mark dead pending/missing calls as interrupted once the conversation moved on
 */
export function normalizeToolTimeline(messages: LLMMessage[]): NormalizedToolTimeline {
  const result: LLMMessage[] = [];
  let hasInterruptedToolCalls = false;

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

    const batchClosed = cursor < messages.length;
    for (const tc of msg.toolCalls) {
      const toolMsg = bestById.get(tc.id);
      if (toolMsg) {
        if (toolMsg.toolStatus === "pending" && batchClosed) {
          result.push(createInterruptedToolResult(tc));
          hasInterruptedToolCalls = true;
        } else {
          result.push(toolMsg);
        }
      } else {
        if (batchClosed) {
          result.push(createInterruptedToolResult(tc));
          hasInterruptedToolCalls = true;
        } else {
          result.push(createPendingToolMessage(tc));
        }
      }
    }

    i = cursor - 1;
  }

  return {
    messages: result,
    changed: JSON.stringify(result) !== JSON.stringify(messages),
    hasInterruptedToolCalls,
  };
}

export function buildPersistentToolRepair(messages: LLMMessage[]): PersistentToolRepair {
  const normalized = normalizeToolTimeline(messages);
  const repairedMessages = normalized.messages.map((msg) => {
    if (msg.role === "tool" && msg.toolStatus === "interrupted") {
      return {
        ...msg,
        content: typeof msg.content === "string"
          ? msg.content.replace("[Interrupted:", "[Error:")
          : msg.content,
        toolStatus: "synthetic" as const,
      };
    }
    return msg;
  });

  return {
    messages: repairedMessages,
    changed: JSON.stringify(repairedMessages) !== JSON.stringify(messages),
    needsRepair: normalized.hasInterruptedToolCalls,
  };
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
