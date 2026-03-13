import type { ContentPart } from '../core/types.js';

export type ProviderSidecarData = Record<string, unknown>;

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  thinking?: string;
  truncated?: boolean;
  ts?: number;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "pending" | "completed" | "failed" | "synthetic" | "interrupted";
  toolCalls?: LLMToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  providerSidecarData?: ProviderSidecarData;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  providerSidecarData?: ProviderSidecarData;
}

export interface LLMResponse {
  content: string | ContentPart[];
  thinking?: string;
  toolCalls?: LLMToolCall[];
  usage?: { inputTokens: number; outputTokens: number; thinkingTokens?: number };
  /** True when the response was cut short by an AbortSignal mid-stream. */
  truncated?: boolean;
  providerSidecarData?: ProviderSidecarData;
}

export type StreamChunk =
  | { type: "text"; text: string; providerSidecarData?: ProviderSidecarData }
  | { type: "thinking"; text: string; providerSidecarData?: ProviderSidecarData }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
      providerSidecarData?: ProviderSidecarData;
    }
  | { type: "provider_sidecar"; providerSidecarData: ProviderSidecarData }
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
