import type { ContentPart, InputModality } from "./types.js";

/** Ensure content is always ContentPart[]. */
export function normalizeContent(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

/** Extract text-only string from string | ContentPart[]. */
export function contentToString(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Filter/degrade content parts based on model's supported input modalities.
 * Unsupported modalities are converted to text placeholders instead of being silently dropped.
 */
export function modalityFilter(
  parts: ContentPart[],
  supported: InputModality[],
): ContentPart[] {
  return parts.map((p) => {
    if (p.type === "text") return p;
    if (p.type === "image" && !supported.includes("image")) {
      return { type: "text" as const, text: "[Image: 模型不支持图片输入]" };
    }
    return p;
  });
}
