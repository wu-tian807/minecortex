import type { ContentPart } from '../core/types.js';

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  thinking?: string;
  truncated?: boolean;
  ts?: number;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string | ContentPart[];
  thinking?: string;
  rawAssistantMessage?: unknown;
  toolCalls?: LLMToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface LLMProvider {
  chatStream(
    messages: LLMMessage[],
    tools: import('../core/types.js').ToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk>;

  supportsResponseAPI?: boolean;
  chatResponseStream?(params: {
    previousResponseId?: string;
    input: LLMMessage[];
    tools: import('../core/types.js').ToolDefinition[];
    signal: AbortSignal;
    store?: boolean;
  }): AsyncIterable<StreamChunk & { responseId?: string }>;
}
