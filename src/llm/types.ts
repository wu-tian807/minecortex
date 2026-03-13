import type { ContentPart } from '../core/types.js';

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  thinking?: string;
  /** Gemini thought signature for thinking blocks (base64). */
  thinkingSignature?: string;
  truncated?: boolean;
  ts?: number;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "pending" | "completed" | "failed" | "synthetic" | "interrupted";
  toolCalls?: LLMToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  /** Gemini thought signature for the last text block (base64). */
  textSignature?: string;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Gemini thought signature for this function call (base64). */
  thoughtSignature?: string;
}

export interface LLMResponse {
  content: string | ContentPart[];
  thinking?: string;
  thinkingSignature?: string;
  textSignature?: string;
  toolCalls?: LLMToolCall[];
  usage?: { inputTokens: number; outputTokens: number; thinkingTokens?: number };
  /** True when the response was cut short by an AbortSignal mid-stream. */
  truncated?: boolean;
}

export type StreamChunk =
  | { type: "text"; text: string; thoughtSignature?: string }
  | { type: "thinking"; text: string; thoughtSignature?: string }
  | { type: "tool_call"; id: string; name: string; arguments: string; thoughtSignature?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; thinkingTokens?: number };

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
