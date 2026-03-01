import type { ContentPart, ModelSpec } from "./types.js";

const DEFAULT_TOKENS_PER_CHAR = 0.25;
const IMAGE_TOKEN_ESTIMATE = 3000;
const VIDEO_TOKEN_ESTIMATE = 12000;
const AUDIO_TOKEN_ESTIMATE = 6000;

/**
 * Local fallback estimation when API usage is unavailable.
 * Prefer real usage from LLMResponse.usage when possible.
 */
export function estimateTokens(
  content: string | ContentPart[],
  spec?: Pick<ModelSpec, "tokensPerChar">,
): number {
  const tpc = spec?.tokensPerChar ?? DEFAULT_TOKENS_PER_CHAR;

  if (typeof content === "string") {
    return Math.ceil(content.length * tpc);
  }

  let total = 0;
  for (const part of content) {
    switch (part.type) {
      case "text":
        total += part.text.length * tpc;
        break;
      case "image":
        total += IMAGE_TOKEN_ESTIMATE;
        break;
      case "video":
        total += VIDEO_TOKEN_ESTIMATE;
        break;
      case "audio":
        total += AUDIO_TOKEN_ESTIMATE;
        break;
    }
  }
  return Math.ceil(total);
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
}

/**
 * Merge API-returned usage into a cumulative counter.
 * When API provides real usage, it takes precedence over estimation.
 */
export function mergeUsage(
  existing: TokenUsage,
  incoming: Partial<TokenUsage>,
): TokenUsage {
  return {
    inputTokens: existing.inputTokens + (incoming.inputTokens ?? 0),
    outputTokens: existing.outputTokens + (incoming.outputTokens ?? 0),
    thinkingTokens: (existing.thinkingTokens ?? 0) + (incoming.thinkingTokens ?? 0),
  };
}
