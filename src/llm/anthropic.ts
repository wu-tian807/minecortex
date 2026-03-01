/** Anthropic Messages API adapter — SSE streaming, raw fetch, thinking support */

import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { ToolDefinition, ContentPart } from "../core/types.js";
import type { LLMMessage, LLMProvider, StreamChunk } from "./types.js";
import { withRetry } from "./retry.js";
import { parseSSE } from "./stream.js";

function toolDefsToAnthropic(tools?: ToolDefinition[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function contentToAnthropic(content: string | ContentPart[]): any {
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "image")
      return {
        type: "image",
        source: { type: "base64", media_type: p.mimeType, data: p.data },
      };
    return { type: "text", text: p.text };
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
            content: contentToAnthropic(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const blocks: any[] = [];
      if (msg.content) {
        const c = contentToAnthropic(msg.content);
        if (typeof c === "string") {
          if (c) blocks.push({ type: "text", text: c });
        } else {
          blocks.push(...c);
        }
      }
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
      content: contentToAnthropic(msg.content),
    });
  }
  return result;
}

function createAnthropicProvider(opts: ProviderFactoryOpts): LLMProvider {
  const { apiKey, baseUrl, authType } = opts;
  const base = (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const model = opts.model;
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 4096;
  const reasoningEffort = opts.reasoningEffort;

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
    async *chatStream(messages, tools, signal) {
      const system = extractSystemText(messages);
      const anthropicMessages = messagesToAnthropic(messages);
      const anthropicTools = toolDefsToAnthropic(tools);

      const body: any = {
        model,
        messages: anthropicMessages,
        max_tokens: maxTokens,
        stream: true,
      };
      if (system) body.system = system;
      if (anthropicTools) body.tools = anthropicTools;

      if (reasoningEffort) {
        const budget =
          reasoningEffort === "high"
            ? 32768
            : reasoningEffort === "medium"
              ? 16384
              : 8192;
        body.thinking = { type: "enabled", budget_tokens: budget };
        body.temperature = 1; // required when thinking is enabled
      } else {
        body.temperature = temperature;
      }

      const response = await withRetry(async () => {
        const res = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(
            `Anthropic API error ${res.status}: ${text.slice(0, 500)}`,
          );
          (err as any).status = res.status;
          throw err;
        }
        return res;
      });

      let currentBlock: {
        type: string;
        id?: string;
        name?: string;
        arguments: string;
      } | null = null;
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const { event, data } of parseSSE(response)) {
        if (signal.aborted) break;

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const eventType = event ?? parsed.type;

        switch (eventType) {
          case "message_start":
            inputTokens = parsed.message?.usage?.input_tokens ?? 0;
            break;

          case "content_block_start": {
            const block = parsed.content_block;
            if (block?.type === "tool_use") {
              currentBlock = {
                type: "tool_use",
                id: block.id,
                name: block.name,
                arguments: "",
              };
            } else if (block?.type === "thinking") {
              currentBlock = { type: "thinking", arguments: "" };
            } else {
              currentBlock = { type: "text", arguments: "" };
            }
            break;
          }

          case "content_block_delta": {
            const delta = parsed.delta;
            if (delta?.type === "text_delta" && delta.text) {
              yield { type: "text", text: delta.text };
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              yield { type: "thinking", text: delta.thinking };
            } else if (
              delta?.type === "input_json_delta" &&
              delta.partial_json &&
              currentBlock
            ) {
              currentBlock.arguments += delta.partial_json;
            }
            break;
          }

          case "content_block_stop":
            if (currentBlock?.type === "tool_use") {
              yield {
                type: "tool_call",
                id: currentBlock.id!,
                name: currentBlock.name!,
                arguments: currentBlock.arguments,
              };
            }
            currentBlock = null;
            break;

          case "message_delta":
            outputTokens = parsed.usage?.output_tokens ?? outputTokens;
            break;

          case "message_stop":
            yield { type: "usage", inputTokens, outputTokens };
            break;
        }
      }
    },
  };
}

registerProvider("anthropic-messages", createAnthropicProvider);

export { createAnthropicProvider };
