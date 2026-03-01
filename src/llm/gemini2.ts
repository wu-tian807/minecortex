/** Gemini 2.x adapter — thinkingBudget, no thought signature requirements */

import { GoogleGenAI } from "@google/genai";
import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { LLMMessage, LLMProvider } from "./types.js";
import { withRetry } from "./retry.js";
import {
  toolDefsToGemini,
  contentPartsToGemini,
  extractSystemText,
  extractTextContent,
  toolResultToGemini,
  streamGeminiResponse,
} from "./gemini-shared.js";

function messagesToGemini2(messages: LLMMessage[]): any[] {
  const contents: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      contents.push(toolResultToGemini(msg));
      continue;
    }

    if (msg.role === "assistant") {
      const parts: any[] = [];

      if (msg.thinking) {
        parts.push({ thought: true, text: msg.thinking });
      }

      const textContent = extractTextContent(msg);
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
  const showThinking = opts.showThinking ?? false;

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
        config.thinkingConfig = { includeThoughts: showThinking, thinkingBudget: budget };
      }

      const response = await withRetry(() =>
        client.models.generateContentStream({ model, contents, config }),
      );

      yield* streamGeminiResponse(response, signal);
    },
  };
}

registerProvider("google-generative-ai", createGemini2Provider);

export { createGemini2Provider };
