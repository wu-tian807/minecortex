/** Gemini adapter — streaming-first, multimodal, thinking support */

import { GoogleGenAI } from "@google/genai";
import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { ToolDefinition, ContentPart } from "../core/types.js";
import type { LLMMessage, LLMProvider, StreamChunk } from "./types.js";
import { withRetry } from "./retry.js";

function toolDefsToGemini(tools?: ToolDefinition[]): any[] | undefined {
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

function contentPartsToGemini(content: string | ContentPart[]): any[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((p) => {
    if (p.type === "text") return { text: p.text };
    return { inlineData: { data: p.data, mimeType: p.mimeType } };
  });
}

function extractSystemText(messages: LLMMessage[]): string | undefined {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return undefined;
  if (typeof sys.content === "string") return sys.content;
  return sys.content
    .filter((p) => p.type === "text")
    .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
    .join("\n");
}

function messagesToGemini(messages: LLMMessage[]): any[] {
  const contents: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      const resultText =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((p) => p.type === "text")
              .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
              .join("");
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.toolCallId ?? "_tool",
              response: { result: resultText },
            },
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const parts: any[] = [];
      if (msg.content) parts.push(...contentPartsToGemini(msg.content));
      for (const tc of msg.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: contentPartsToGemini(msg.content),
    });
  }
  return contents;
}

function createGeminiProvider(opts: ProviderFactoryOpts): LLMProvider {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model;
  const temperature = opts.temperature;
  const maxOutputTokens = opts.maxTokens;
  const reasoningEffort = opts.reasoningEffort;

  return {
    async *chatStream(messages, tools, signal) {
      const contents = messagesToGemini(messages);
      const geminiTools = toolDefsToGemini(tools);
      const systemInstruction = extractSystemText(messages);

      const config: any = {
        systemInstruction,
        tools: geminiTools,
        temperature,
        maxOutputTokens,
      };

      if (reasoningEffort) {
        const budget =
          reasoningEffort === "high"
            ? 32768
            : reasoningEffort === "medium"
              ? 16384
              : 4096;
        config.thinkingConfig = { thinkingBudget: budget };
      }

      const response = await withRetry(() =>
        client.models.generateContentStream({ model, contents, config }),
      );

      for await (const chunk of response) {
        if (signal.aborted) break;

        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.functionCall) {
              yield {
                type: "tool_call",
                id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: part.functionCall.name!,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              };
            } else if (part.text != null) {
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
    },
  };
}

registerProvider("google-generative-ai", createGeminiProvider);

export { createGeminiProvider };
