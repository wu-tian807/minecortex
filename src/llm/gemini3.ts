/** Gemini 3.x adapter — thinkingLevel, thought signatures required on function calls */

import { GoogleGenAI } from "@google/genai";
import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { LLMMessage, LLMProvider, LLMToolCall, ProviderSidecarData, StreamChunk } from "./types.js";
import {
  collectToolResponsesToGemini,
  toolDefsToGemini,
  contentPartsToGemini,
  extractSystemText,
} from "./gemini-shared.js";
import { extractTextContent } from "./thinking.js";

interface GoogleToolCallSidecar {
  id: string;
  thoughtSignature?: string;
}

interface GoogleMessageSidecar {
  thinkingSignature?: string;
  textSignature?: string;
  toolCalls?: GoogleToolCallSidecar[];
}

function readGoogleSidecar(msg: LLMMessage): GoogleMessageSidecar | null {
  const raw = msg.providerSidecarData?.google;
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const toolCalls = Array.isArray(entry.toolCalls)
    ? entry.toolCalls.flatMap((item): GoogleToolCallSidecar[] => {
        if (!item || typeof item !== "object") return [];
        const toolCall = item as Record<string, unknown>;
        return typeof toolCall.id === "string"
          ? [{
              id: toolCall.id,
              thoughtSignature:
                typeof toolCall.thoughtSignature === "string" ? toolCall.thoughtSignature : undefined,
            }]
          : [];
      })
    : undefined;

  return {
    thinkingSignature:
      typeof entry.thinkingSignature === "string" ? entry.thinkingSignature : undefined,
    textSignature: typeof entry.textSignature === "string" ? entry.textSignature : undefined,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
  };
}

function getGoogleThinkingSignature(msg: LLMMessage): string | undefined {
  return readGoogleSidecar(msg)?.thinkingSignature;
}

function getGoogleTextSignature(msg: LLMMessage): string | undefined {
  return readGoogleSidecar(msg)?.textSignature;
}

function getGoogleToolCallThoughtSignature(tc: LLMToolCall): string | undefined {
  const raw = tc.providerSidecarData?.google;
  if (!raw || typeof raw !== "object") return undefined;
  return typeof (raw as Record<string, unknown>).thoughtSignature === "string"
    ? ((raw as Record<string, unknown>).thoughtSignature as string)
    : undefined;
}

function buildGoogleProviderSidecar(params: {
  thinkingSignature?: string;
  textSignature?: string;
  toolCalls?: GoogleToolCallSidecar[];
}): ProviderSidecarData | undefined {
  const toolCalls = params.toolCalls?.filter((toolCall) => toolCall.thoughtSignature);
  if (!params.thinkingSignature && !params.textSignature && !toolCalls?.length) {
    return undefined;
  }
  return {
    google: {
      ...(params.thinkingSignature ? { thinkingSignature: params.thinkingSignature } : {}),
      ...(params.textSignature ? { textSignature: params.textSignature } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
    },
  };
}

async function* streamGemini3Response(
  response: AsyncIterable<any>,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk> {
  let hasContent = false;
  let lastFinishReason: string | undefined;
  let thinkingSignature: string | undefined;
  let textSignature: string | undefined;
  const toolCalls: GoogleToolCallSidecar[] = [];

  for await (const chunk of response) {
    if (signal.aborted) break;

    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) {
      lastFinishReason = candidate.finishReason as string;
    }

    const parts = candidate?.content?.parts;
    if (parts) {
      for (const part of parts) {
        const thoughtSignature = (part as any).thoughtSignature as string | undefined;

        if (part.functionCall) {
          hasContent = true;
          const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          toolCalls.push({ id, thoughtSignature });
          yield {
            type: "tool_call",
            id,
            name: part.functionCall.name!,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
            providerSidecarData: thoughtSignature
              ? { google: { thoughtSignature } }
              : undefined,
          };
          continue;
        }

        if (part.text != null) {
          hasContent = true;
          if ((part as any).thought) {
            if (thoughtSignature) thinkingSignature = thoughtSignature;
            yield {
              type: "thinking",
              text: part.text,
              providerSidecarData: thoughtSignature
                ? { google: { thinkingSignature: thoughtSignature } }
                : undefined,
            };
          } else {
            if (thoughtSignature) textSignature = thoughtSignature;
            yield {
              type: "text",
              text: part.text,
              providerSidecarData: thoughtSignature
                ? { google: { textSignature: thoughtSignature } }
                : undefined,
            };
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

  if (
    !hasContent &&
    !signal.aborted &&
    lastFinishReason &&
    lastFinishReason !== "STOP" &&
    lastFinishReason !== "MAX_TOKENS"
  ) {
    yield { type: "text", text: `[Gemini blocked: finishReason=${lastFinishReason}]` };
  }

  const providerSidecarData = buildGoogleProviderSidecar({
    thinkingSignature,
    textSignature,
    toolCalls,
  });
  if (providerSidecarData) {
    yield { type: "provider_sidecar", providerSidecarData };
  }
}

function messagesToGemini3(messages: LLMMessage[]): any[] {
  const contents: any[] = [];
  let textFallbackForNextToolTurn = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      const grouped = collectToolResponsesToGemini(messages, i, {
        textFallback: textFallbackForNextToolTurn,
      });
      contents.push(grouped.content);
      textFallbackForNextToolTurn = false;
      i = grouped.nextIndex - 1;
      continue;
    }

    if (msg.role === "assistant") {
      const parts: any[] = [];
      const shouldTextifyToolBatch =
        msg.toolCalls?.some((tc) => !getGoogleToolCallThoughtSignature(tc)) ?? false;

      const thinkingSignature = getGoogleThinkingSignature(msg);
      if (msg.thinking || thinkingSignature) {
        const part: any = { thought: true, text: msg.thinking ?? "" };
        if (thinkingSignature) part.thoughtSignature = thinkingSignature;
        parts.push(part);
      }

      const textContent = extractTextContent(msg.content);
      if (textContent) {
        const part: any = { text: textContent };
        const textSignature = getGoogleTextSignature(msg);
        if (textSignature) part.thoughtSignature = textSignature;
        parts.push(part);
      }

      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          if (shouldTextifyToolBatch) {
            const argsStr = JSON.stringify(tc.arguments ?? {}, null, 2);
            parts.push({
              text: `[Historical context: tool "${tc.name}" was called with arguments: ${argsStr}. Do not mimic this format - use proper function calling.]`,
            });
          } else {
            const thoughtSignature = getGoogleToolCallThoughtSignature(tc);
            parts.push({
              functionCall: { name: tc.name, args: tc.arguments },
              thoughtSignature,
            });
          }
        }

        textFallbackForNextToolTurn = shouldTextifyToolBatch;
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
        config.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
      }

      const response = await client.models.generateContentStream({ model, contents, config });

      yield* streamGemini3Response(response, signal);
    },
  };
}

registerProvider("google-gemini-3", createGemini3Provider);

export { createGemini3Provider };
