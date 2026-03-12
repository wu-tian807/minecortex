import type { ContentPart } from "./types.js";

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
): number {
  if (typeof content === "string") {
    return Math.ceil(content.length * DEFAULT_TOKENS_PER_CHAR);
  }

  let total = 0;
  for (const part of content) {
    switch (part.type) {
      case "text":
        total += part.text.length * DEFAULT_TOKENS_PER_CHAR;
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
