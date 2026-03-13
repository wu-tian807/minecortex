/** Shared utilities for Gemini 2.x and 3.x adapters */

import type { ContentPart } from "../core/types.js";
import type { LLMMessage } from "./types.js";
import type { ToolDefinition } from "../core/types.js";

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeGeminiSchema(item));
  }
  if (schema == null || typeof schema !== "object") {
    return schema;
  }

  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    output[key] = sanitizeGeminiSchema(value);
  }

  const enumValues = input.enum;
  if (Array.isArray(enumValues) && enumValues.some((value) => typeof value !== "string")) {
    delete output.enum;

    const allowedValues = enumValues.map((value) => JSON.stringify(value)).join(", ");
    const note = `Allowed values: ${allowedValues}.`;
    const description =
      typeof output.description === "string" ? output.description.trim() : "";
    output.description = description ? `${description} ${note}` : note;
  }

  return output;
}

export function toolDefsToGemini(tools?: ToolDefinition[]): any[] | undefined {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Google function schemas reject some JSON Schema variants such as numeric enum values.
        parameters: sanitizeGeminiSchema({
          type: "object",
          properties: t.input_schema.properties,
          required: t.input_schema.required,
        }),
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

function toolResultText(msg: LLMMessage): string {
  return typeof msg.content === "string"
    ? msg.content
    : msg.content
        .filter((p) => p.type === "text")
        .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
        .join("");
}

interface ToolResponseCollectOptions {
  textFallback?: boolean;
}

/** Convert a terminal tool result message into a Gemini functionResponse part. */
export function toolResultPartToGemini(msg: LLMMessage): any {
  const functionName = msg.toolName ?? "unknown_tool";
  const resultText = toolResultText(msg);
  const response: Record<string, unknown> = { result: resultText };
  if (msg.toolCallId) response.toolCallId = msg.toolCallId;
  if (msg.toolStatus) response.status = msg.toolStatus;

  return {
    functionResponse: {
      name: functionName,
      response,
    },
  };
}

/** Group contiguous terminal tool results into one Gemini user turn. */
export function collectToolResponsesToGemini(
  messages: LLMMessage[],
  startIndex: number,
  options: ToolResponseCollectOptions = {},
): {
  content: any;
  nextIndex: number;
} {
  const textFallback = options.textFallback ?? false;
  const parts: any[] = [];
  let index = startIndex;

  while (index < messages.length && messages[index].role === "tool") {
    const msg = messages[index];
    if (msg.toolStatus !== "pending") {
      if (textFallback) {
        const toolName = msg.toolName ?? "unknown_tool";
        const resultText = toolResultText(msg);
        parts.push({
          text: `[Historical tool result: ${toolName}]\n${resultText || "(empty result)"}`,
        });
      } else {
        parts.push(toolResultPartToGemini(msg));
      }
    }
    index++;
  }

  const contentParts =
    parts.length > 0
      ? parts
      : [{ text: "[tool results unavailable]" }];

  return {
    content: {
      role: "user",
      parts: contentParts,
    },
    nextIndex: index,
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
        if (part.functionCall) {
          hasContent = true;
          const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          yield {
            type: "tool_call",
            id,
            name: part.functionCall.name!,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          };
        } else if (part.text != null) {
          hasContent = true;
          if ((part as any).thought) {
            yield { type: "thinking", text: part.text };
          } else {
            yield { type: "text", text: part.text };
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
