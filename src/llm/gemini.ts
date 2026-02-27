/** @desc Gemini 适配器 — 实现 LLMProviderInterface */

import { GoogleGenAI } from "@google/genai";
import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type {
  LLMProviderInterface,
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  ToolDefinition,
} from "../core/types.js";

function toolDefsToGemini(tools?: ToolDefinition[]): any {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [
              k,
              { type: v.type, description: v.description, enum: v.enum },
            ]),
          ),
          required: Object.entries(t.parameters)
            .filter(([, v]) => v.required !== false)
            .map(([k]) => k),
        },
      })),
    },
  ];
}

function messagesToGemini(messages: LLMMessage[]): any[] {
  const contents: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // handled via systemInstruction

    if (msg.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.toolCallId ?? "_tool",
              response: { result: msg.content },
            },
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const parts: any[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) {
        parts.push({
          functionCall: { name: tc.name, args: tc.arguments },
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  }
  return contents;
}

function parseResponse(response: any): LLMResponse {
  const candidate = response.candidates?.[0];
  if (!candidate) {
    return { content: "(no response)" };
  }

  const parts = candidate.content?.parts ?? [];
  let text = "";
  const toolCalls: LLMToolCall[] = [];

  for (const part of parts) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
      });
    }
  }

  const usage = response.usageMetadata;
  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usage
      ? {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
        }
      : undefined,
  };
}

function createGeminiProvider(opts: ProviderFactoryOpts): LLMProviderInterface {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });

  return {
    async chat(messages, tools) {
      const systemMsg = messages.find((m) => m.role === "system");
      const contents = messagesToGemini(messages);
      const geminiTools = toolDefsToGemini(tools);

      const model = (this as any)._model ?? "gemini-2.5-flash";
      const response = await client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: systemMsg?.content,
          tools: geminiTools,
        },
      });

      return parseResponse(response);
    },
  };
}

registerProvider("gemini", createGeminiProvider);

export { createGeminiProvider };
