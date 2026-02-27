/** @desc OpenAI Chat Completions 适配器 — 兼容 DeepSeek/Qwen/Kimi 等 */

import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type {
  LLMProviderInterface,
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  ToolDefinition,
} from "../core/types.js";

function toolDefsToOpenAI(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
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
    },
  }));
}

function messagesToOpenAI(messages: LLMMessage[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content });
      continue;
    }

    if (msg.role === "tool") {
      result.push({
        role: "tool",
        tool_call_id: msg.toolCallId ?? "_tool",
        content: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const assistantMsg: any = { role: "assistant" };
      if (msg.content) assistantMsg.content = msg.content;
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

    result.push({
      role: msg.role,
      content: msg.content,
    });
  }

  return result;
}

function parseResponse(data: any): LLMResponse {
  const choice = data.choices?.[0];
  if (!choice) {
    return { content: "(no response)" };
  }

  let text = choice.message?.content ?? "";
  const toolCalls: LLMToolCall[] = [];

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch { /* malformed JSON */ }
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: args,
      });
    }
  }

  if (!text && toolCalls.length === 0) {
    text = "(empty response)";
  }

  const usage = data.usage;
  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usage
      ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 }
      : undefined,
  };
}

function normalizeBaseUrl(url: string): string {
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url;
}

function createOpenAICompatProvider(opts: ProviderFactoryOpts): LLMProviderInterface {
  const { apiKey, baseUrl } = opts;
  const base = normalizeBaseUrl(baseUrl ?? "https://api.openai.com/v1");

  return {
    async chat(messages, tools) {
      const openaiMessages = messagesToOpenAI(messages);
      const openaiTools = toolDefsToOpenAI(tools);
      const model = (this as any)._model ?? "gpt-4o";

      const body: any = {
        model,
        messages: openaiMessages,
      };
      if (openaiTools) body.tools = openaiTools;

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI-compat API error ${res.status}: ${errText.slice(0, 500)}`);
      }

      const data = await res.json();
      return parseResponse(data);
    },
  };
}

registerProvider("openai-completions", createOpenAICompatProvider);

export { createOpenAICompatProvider };
