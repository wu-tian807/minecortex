/** @desc Anthropic Messages API 适配器 — 支持 Azure Claude 等 */

import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type {
  LLMProviderInterface,
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  ToolDefinition,
} from "../core/types.js";

function toolDefsToAnthropic(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
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
  }));
}

function messagesToAnthropic(messages: LLMMessage[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "_tool",
            content: msg.content,
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const blocks: any[] = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const tc of msg.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      result.push({ role: "assistant", content: blocks });
      continue;
    }

    result.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }

  return result;
}

function parseResponse(data: any): LLMResponse {
  let text = "";
  const toolCalls: LLMToolCall[] = [];

  for (const item of data.content ?? []) {
    if (item.type === "text") {
      text += item.text;
    } else if (item.type === "tool_use") {
      toolCalls.push({
        id: item.id,
        name: item.name,
        arguments: item.input ?? {},
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
      ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
      : undefined,
  };
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function createAnthropicProvider(opts: ProviderFactoryOpts): LLMProviderInterface {
  const { apiKey, baseUrl, authType } = opts;
  const base = normalizeBase(baseUrl ?? "https://api.anthropic.com");
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 4096;

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (authType === "bearer") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else {
      headers["x-api-key"] = apiKey;
    }
    return headers;
  }

  return {
    async chat(messages, tools) {
      const systemMsg = messages.find((m) => m.role === "system");
      const anthropicMessages = messagesToAnthropic(messages);
      const anthropicTools = toolDefsToAnthropic(tools);
      const model = (this as any)._model ?? "claude-sonnet-4-6";

      const body: any = {
        model,
        messages: anthropicMessages,
        max_tokens: maxTokens,
        temperature,
      };
      if (systemMsg?.content) body.system = systemMsg.content;
      if (anthropicTools) body.tools = anthropicTools;

      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 500)}`);
      }

      const data = await res.json();
      return parseResponse(data);
    },
  };
}

registerProvider("anthropic-messages", createAnthropicProvider);

export { createAnthropicProvider };
