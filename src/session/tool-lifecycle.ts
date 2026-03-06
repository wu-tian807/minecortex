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
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);
  return {
    role: "tool",
    content: resultStr,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolStatus: isToolErrorResult(result) ? "failed" : "completed",
    ts: Date.now(),
  };
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
