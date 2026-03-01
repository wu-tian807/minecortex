import type { ContentPart, ModelSpec } from "./types.js";

const DEFAULT_TOKENS_PER_CHAR = 0.25;
const IMAGE_TOKEN_ESTIMATE = 3000;

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
    if (part.type === "text") {
      total += part.text.length * tpc;
    } else if (part.type === "image") {
      total += IMAGE_TOKEN_ESTIMATE;
    }
  }
  return Math.ceil(total);
}
