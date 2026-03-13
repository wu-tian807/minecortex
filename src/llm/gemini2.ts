/** Gemini 2.x adapter — thinkingBudget, no thought signature requirements */

import { GoogleGenAI } from "@google/genai";
import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { LLMMessage, LLMProvider } from "./types.js";
import {
  collectToolResponsesToGemini,
  toolDefsToGemini,
  contentPartsToGemini,
  extractSystemText,
  streamGeminiResponse,
} from "./gemini-shared.js";
import { extractTextContent } from "./thinking.js";

function messagesToGemini2(messages: LLMMessage[]): any[] {
  const contents: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      const grouped = collectToolResponsesToGemini(messages, i);
      contents.push(grouped.content);
      i = grouped.nextIndex - 1;
      continue;
    }

    if (msg.role === "assistant") {
      const parts: any[] = [];
      const thinkingText = msg.thinking;

      if (thinkingText) {
        parts.push({ thought: true, text: thinkingText });
      }

      const textContent = extractTextContent(msg.content);
      if (textContent) {
        parts.push({ text: textContent });
      }

      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
      }

      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    contents.push({
      role: "user",
      parts: contentPartsToGemini(msg.content),
    });
  }
  return contents;
}

function createGemini2Provider(opts: ProviderFactoryOpts): LLMProvider {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model;
  const temperature = opts.temperature;
  const maxOutputTokens = opts.maxTokens;
  const reasoningEffort = opts.reasoningEffort;

  return {
    async *chatStream(messages, tools, signal) {
      const contents = messagesToGemini2(messages);
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
        config.thinkingConfig = {
          includeThoughts: opts.showThinking ?? false,
          thinkingBudget: budget,
        };
      }

      const response = await client.models.generateContentStream({ model, contents, config });

      yield* streamGeminiResponse(response, signal);
    },
  };
}

registerProvider("google-gemini-2", createGemini2Provider);

export { createGemini2Provider };
