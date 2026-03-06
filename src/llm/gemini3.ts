/** Gemini 3.x adapter — thinkingLevel, thought signatures required on function calls */

import { GoogleGenAI } from "@google/genai";
import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { LLMMessage, LLMProvider } from "./types.js";
import {
  collectToolResponsesToGemini,
  toolDefsToGemini,
  contentPartsToGemini,
  extractSystemText,
  extractTextContent,
  streamGeminiResponse,
} from "./gemini-shared.js";

function messagesToGemini3(messages: LLMMessage[]): any[] {
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

      if (msg.thinking) {
        const part: any = { thought: true, text: msg.thinking };
        if (msg.thinkingSignature) part.thoughtSignature = msg.thinkingSignature;
        parts.push(part);
      }

      const textContent = extractTextContent(msg);
      if (textContent) {
        const part: any = { text: textContent };
        if (msg.textSignature) part.thoughtSignature = msg.textSignature;
        parts.push(part);
      }

      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          if (!tc.thoughtSignature) {
            const argsStr = JSON.stringify(tc.arguments ?? {}, null, 2);
            parts.push({
              text: `[Historical context: tool "${tc.name}" was called with arguments: ${argsStr}. Do not mimic this format - use proper function calling.]`,
            });
          } else {
            parts.push({
              functionCall: { name: tc.name, args: tc.arguments },
              thoughtSignature: tc.thoughtSignature,
            });
          }
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

function createGemini3Provider(opts: ProviderFactoryOpts): LLMProvider {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model;
  const temperature = opts.temperature;
  const maxOutputTokens = opts.maxTokens;
  const reasoningEffort = opts.reasoningEffort;
  const showThinking = opts.showThinking ?? false;

  return {
    async *chatStream(messages, tools, signal) {
      const contents = messagesToGemini3(messages);
      const geminiTools = toolDefsToGemini(tools);
      const systemInstruction = extractSystemText(messages);

      const config: any = {
        systemInstruction,
        tools: geminiTools,
        temperature,
        maxOutputTokens,
      };

      if (reasoningEffort) {
        const level = reasoningEffort === "high" ? "HIGH" : "LOW";
        config.thinkingConfig = { includeThoughts: showThinking, thinkingLevel: level };
      }

      const response = await client.models.generateContentStream({ model, contents, config });

      yield* streamGeminiResponse(response, signal);
    },
  };
}

registerProvider("google-gemini-3", createGemini3Provider);

export { createGemini3Provider };
