/** Shared utilities for Gemini 2.x and 3.x adapters */

import type { ContentPart } from "../core/types.js";
import type { LLMMessage } from "./types.js";
import type { ToolDefinition } from "../core/types.js";

export function toolDefsToGemini(tools?: ToolDefinition[]): any[] | undefined {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties: t.input_schema.properties,
          required: t.input_schema.required,
        },
      })),
    },
  ];
}

export function contentPartsToGemini(content: string | ContentPart[]): any[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((p) => {
    if (p.type === "text") return { text: p.text };
    return { inlineData: { data: p.data, mimeType: p.mimeType } };
  });
}

export function extractSystemText(messages: LLMMessage[]): string | undefined {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return undefined;
  if (typeof sys.content === "string") return sys.content;
  return sys.content
    .filter((p) => p.type === "text")
    .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
    .join("\n");
}

/** Extract plain text from content, stripping <thinking> blocks */
export function extractTextContent(msg: LLMMessage): string {
  if (typeof msg.content === "string") {
    return msg.content.replace(/<thinking>[\s\S]*?<\/thinking>\n?/, "").trim();
  }
  return msg.content
    .filter((p) => p.type === "text")
    .map((p) => (p as any).text)
    .join("");
}

/** Convert tool result message to Gemini functionResponse part */
export function toolResultToGemini(msg: LLMMessage): any {
  const resultText =
    typeof msg.content === "string"
      ? msg.content
      : msg.content
          .filter((p) => p.type === "text")
          .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
          .join("");
  return {
    role: "user",
    parts: [
      {
        functionResponse: {
          name: msg.toolCallId ?? "_tool",
          response: { result: resultText },
        },
      },
    ],
  };
}

/** Stream response parts and yield StreamChunks. Shared streaming logic. */
export async function* streamGeminiResponse(
  response: AsyncIterable<any>,
  signal: AbortSignal,
): AsyncGenerator<import("./types.js").StreamChunk> {
  let hasContent = false;
  let lastFinishReason: string | undefined;

  for await (const chunk of response) {
    if (signal.aborted) break;

    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) {
      lastFinishReason = candidate.finishReason as string;
    }

    const parts = candidate?.content?.parts;
    if (parts) {
      for (const part of parts) {
        const sig = (part as any).thoughtSignature as string | undefined;

        if (part.functionCall) {
          hasContent = true;
          yield {
            type: "tool_call",
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name!,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
            thoughtSignature: sig,
          };
        } else if (part.text != null) {
          hasContent = true;
          if ((part as any).thought) {
            yield { type: "thinking", text: part.text, thoughtSignature: sig };
          } else {
            yield { type: "text", text: part.text, thoughtSignature: sig };
          }
        }
      }
    }

    if (chunk.usageMetadata) {
      const meta = chunk.usageMetadata as any;
      const candidatesTokens = meta.candidatesTokenCount ?? 0;
      const thinkingTokens = meta.thoughtsTokenCount ?? 0;
      yield {
        type: "usage",
        inputTokens: meta.promptTokenCount ?? 0,
        outputTokens: candidatesTokens + thinkingTokens,
        thinkingTokens: thinkingTokens || undefined,
      };
    }
  }

  if (!hasContent && !signal.aborted && lastFinishReason && lastFinishReason !== "STOP" && lastFinishReason !== "MAX_TOKENS") {
    yield { type: "text", text: `[Gemini blocked: finishReason=${lastFinishReason}]` };
  }
}
