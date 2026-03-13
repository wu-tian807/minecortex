/** OpenAI Chat Completions adapter — SSE streaming, multimodal */

import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { ToolDefinition, ContentPart, ReasoningEffort } from "../core/types.js";
import type { LLMMessage, LLMProvider, StreamChunk } from "./types.js";
import { parseSSE } from "./stream.js";

export function toolDefsToOpenAI(tools?: ToolDefinition[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export function contentToOpenAI(content: string | ContentPart[]): any {
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image")
      return {
        type: "image_url",
        image_url: { url: `data:${p.mimeType};base64,${p.data}` },
      };
    return { type: "text", text: `[${p.type} content]` };
  });
}

export function messagesToOpenAI(messages: LLMMessage[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: contentToOpenAI(msg.content) });
      continue;
    }

    if (msg.role === "tool") {
      if (msg.toolStatus === "pending") continue;
      result.push({
        role: "tool",
        tool_call_id: msg.toolCallId ?? "_tool",
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((p) => p.type === "text")
                .map((p) => (p as Extract<ContentPart, { type: "text" }>).text)
                .join(""),
      });
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const assistantMsg: any = { role: "assistant" };
      if (msg.content) assistantMsg.content = contentToOpenAI(msg.content);
      assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
      result.push(assistantMsg);
      continue;
    }

    result.push({ role: msg.role, content: contentToOpenAI(msg.content) });
  }
  return result;
}

// ── Shared streaming logic (reused by deepseek-reasoning) ──

export interface OpenAIStreamOpts {
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  extractReasoning?: boolean;
}

export async function* openAICompatStream(
  streamOpts: OpenAIStreamOpts,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const openaiMessages = messagesToOpenAI(messages);
  const openaiTools = toolDefsToOpenAI(tools);

  const body: any = {
    model: streamOpts.model,
    messages: openaiMessages,
    temperature: streamOpts.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (streamOpts.maxTokens) body.max_tokens = streamOpts.maxTokens;
  if (openaiTools) body.tools = openaiTools;
  if (streamOpts.reasoningEffort)
    body.reasoning_effort = streamOpts.reasoningEffort;

  const res = await fetch(`${streamOpts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${streamOpts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `OpenAI-compat API error ${res.status}: ${text.slice(0, 500)}`,
    );
    (err as any).status = res.status;
    // 解析 Retry-After 头
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        (err as any).retryAfterMs = seconds * 1000;
      }
    }
    throw err;
  }
  const response = res;

  const pendingToolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const { data } of parseSSE(response)) {
    if (data === "[DONE]") break;
    if (signal.aborted) break;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      if (parsed.usage) {
        const reasoning = parsed.usage.completion_tokens_details?.reasoning_tokens;
        yield {
          type: "usage",
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
          thinkingTokens: reasoning || undefined,
        };
      }
      continue;
    }

    const delta = choice.delta;
    if (!delta) continue;

    if (streamOpts.extractReasoning && delta.reasoning_content) {
      yield { type: "thinking", text: delta.reasoning_content };
    }

    if (delta.content) {
      yield { type: "text", text: delta.content };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!pendingToolCalls.has(idx)) {
          pendingToolCalls.set(idx, {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            arguments: "",
          });
        }
        const pending = pendingToolCalls.get(idx)!;
        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name = tc.function.name;
        if (tc.function?.arguments) pending.arguments += tc.function.arguments;
      }
    }

    if (
      choice.finish_reason === "tool_calls" ||
      choice.finish_reason === "stop"
    ) {
      for (const [, tc] of pendingToolCalls) {
        yield {
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        };
      }
      pendingToolCalls.clear();
    }
  }

  for (const [, tc] of pendingToolCalls) {
    yield {
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    };
  }
}

// ── Provider factory ──

function normalizeBaseUrl(url: string): string {
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url;
}

function createOpenAICompatProvider(opts: ProviderFactoryOpts): LLMProvider {
  return {
    async *chatStream(messages, tools, signal) {
      yield* openAICompatStream(
        {
          model: opts.model,
          apiKey: opts.apiKey,
          baseUrl: normalizeBaseUrl(opts.baseUrl ?? "https://api.openai.com"),
          temperature: opts.temperature ?? 0.7,
          maxTokens: opts.maxTokens,
          reasoningEffort: opts.reasoningEffort,
        },
        messages,
        tools,
        signal,
      );
    },
  };
}

registerProvider("openai-completions", createOpenAICompatProvider);

export { createOpenAICompatProvider };
