import type { ContentPart } from "../core/types.js";
import type { LLMMessage, LLMToolCall } from "../llm/types.js";

export interface ToolLifecycleSink {
  appendAssistantTurn(msg: LLMMessage): Promise<void>;
  appendToolPendings(toolCalls: LLMToolCall[]): Promise<void>;
  appendToolResult(toolCall: LLMToolCall, result: unknown): Promise<void>;
}

export function isToolErrorResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

export function isTerminalToolMessage(msg: LLMMessage): boolean {
  return msg.role === "tool" && msg.toolStatus !== "pending";
}

export function createPendingToolMessages(toolCalls: LLMToolCall[]): LLMMessage[] {
  return toolCalls.map((tc) => ({
    role: "tool",
    content: `[Pending: ${tc.name}]`,
    toolCallId: tc.id,
    toolName: tc.name,
    toolStatus: "pending",
    ts: Date.now(),
  }));
}

export function createToolResultMessage(toolCall: LLMToolCall, result: unknown): LLMMessage {
  // Preserve ContentPart[] (multimodal tool output) as-is so the LLM adapter
  // can format image/audio/video blocks correctly.  Plain strings pass through
  // directly; everything else is JSON-serialised to a string.
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
