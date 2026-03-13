/** Anthropic Messages API adapter — SSE streaming, raw fetch, thinking support */

import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { ToolDefinition, ContentPart } from "../core/types.js";
import type { LLMMessage, LLMProvider, StreamChunk } from "./types.js";
import { parseSSE } from "./stream.js";

type AnthropicAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface AnthropicSidecar {
  contentBlocks: AnthropicAssistantBlock[];
}

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
  return content.flatMap((p) => {
    switch (p.type) {
      case "image":
        return {
          type: "image",
          source: { type: "base64", media_type: p.mimeType, data: p.data },
        };
      case "text":
        return { type: "text", text: p.text };
      case "video":
      case "audio":
        return { type: "text", text: `[${p.type}: unsupported by Anthropic]` };
    }
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

function toAnthropicSidecar(sidecarData: LLMMessage["providerSidecarData"]): AnthropicSidecar | null {
  const raw = sidecarData?.anthropic;
  if (!raw || typeof raw !== "object") return null;
  const contentBlocks = (raw as { contentBlocks?: unknown }).contentBlocks;
  if (!Array.isArray(contentBlocks)) return null;

  const normalized = contentBlocks.flatMap((block): AnthropicAssistantBlock[] => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    switch (item.type) {
      case "text":
        return typeof item.text === "string" ? [{ type: "text", text: item.text }] : [];
      case "thinking":
        return typeof item.thinking === "string"
          ? [{
              type: "thinking",
              thinking: item.thinking,
              signature: typeof item.signature === "string" ? item.signature : undefined,
            }]
          : [];
      case "redacted_thinking":
        return typeof item.data === "string"
          ? [{ type: "redacted_thinking", data: item.data }]
          : [];
      case "tool_use":
        return typeof item.id === "string" &&
          typeof item.name === "string" &&
          item.input &&
          typeof item.input === "object" &&
          !Array.isArray(item.input)
          ? [{
              type: "tool_use",
              id: item.id,
              name: item.name,
              input: item.input as Record<string, unknown>,
            }]
          : [];
      default:
        return [];
    }
  });

  return normalized.length > 0 ? { contentBlocks: normalized } : null;
}

function anthropicBlocksToApi(blocks: AnthropicAssistantBlock[]): any[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          ...(block.signature ? { signature: block.signature } : {}),
        };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: block.data };
      default:
        return block;
    }
  });
}

function fallbackAssistantBlocks(msg: LLMMessage): any[] {
  const blocks: any[] = [];
  if (msg.content) {
    const c = contentToAnthropic(msg.content);
    if (typeof c === "string") {
      if (c) blocks.push({ type: "text", text: c });
    } else {
      blocks.push(...c);
    }
  }
  for (const tc of msg.toolCalls ?? []) {
    blocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.arguments,
    });
  }
  return blocks;
}

function assistantMessageToAnthropicContent(msg: LLMMessage): any[] {
  const sidecar = toAnthropicSidecar(msg.providerSidecarData);
  if (sidecar?.contentBlocks.length) {
    return anthropicBlocksToApi(sidecar.contentBlocks);
  }
  return fallbackAssistantBlocks(msg);
}

function messagesToAnthropic(messages: LLMMessage[]): any[] {
  const result: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      const toolBlocks: any[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMsg = messages[j];
        if (toolMsg.toolStatus !== "pending") {
          toolBlocks.push({
            type: "tool_result",
            tool_use_id: toolMsg.toolCallId ?? "_tool",
            content: contentToAnthropic(toolMsg.content),
          });
        }
        j++;
      }
      if (toolBlocks.length > 0) {
        result.push({
          role: "user",
          content: toolBlocks,
        });
      }
      i = j - 1;
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = assistantMessageToAnthropicContent(msg);
      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    result.push({
      role: "user",
      content: contentToAnthropic(msg.content),
    });
  }
  return result;
}

function createAnthropicProvider(opts: ProviderFactoryOpts): LLMProvider {
  const { apiKey, baseUrl } = opts;
  const base = (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${base}/v1/messages`;
  const model = opts.model;
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 4096;
  const reasoningEffort = opts.reasoningEffort;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": apiKey,
  };

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

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(
          `Anthropic API error ${res.status} [POST ${url}]: ${text.slice(0, 500)}`,
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

      let currentBlock:
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string; signature?: string }
        | { type: "redacted_thinking"; data: string }
        | { type: "tool_use"; id?: string; name?: string; arguments: string }
        | null = null;
      const assistantBlocks: AnthropicAssistantBlock[] = [];
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
              currentBlock = {
                type: "thinking",
                thinking: typeof block.thinking === "string" ? block.thinking : "",
                signature: typeof block.signature === "string" ? block.signature : undefined,
              };
            } else if (block?.type === "redacted_thinking") {
              currentBlock = {
                type: "redacted_thinking",
                data: typeof block.data === "string" ? block.data : "",
              };
            } else {
              currentBlock = {
                type: "text",
                text: typeof block?.text === "string" ? block.text : "",
              };
            }
            break;
          }

          case "content_block_delta": {
            const delta = parsed.delta;
            if (delta?.type === "text_delta" && delta.text) {
              if (currentBlock?.type === "text") currentBlock.text += delta.text;
              yield { type: "text", text: delta.text };
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              if (currentBlock?.type === "thinking") currentBlock.thinking += delta.thinking;
              yield { type: "thinking", text: delta.thinking };
            } else if (delta?.type === "signature_delta" && currentBlock?.type === "thinking") {
              currentBlock.signature = delta.signature;
            } else if (
              delta?.type === "input_json_delta" &&
              delta.partial_json &&
              currentBlock
            ) {
              if (currentBlock.type === "tool_use") {
                currentBlock.arguments += delta.partial_json;
              }
            }
            break;
          }

          case "content_block_stop":
            if (currentBlock?.type === "tool_use") {
              let parsedArguments: Record<string, unknown> = {};
              try {
                parsedArguments = currentBlock.arguments ? JSON.parse(currentBlock.arguments) : {};
              } catch {}
              assistantBlocks.push({
                type: "tool_use",
                id: currentBlock.id ?? "_tool",
                name: currentBlock.name ?? "unknown_tool",
                input: parsedArguments,
              });
              yield {
                type: "tool_call",
                id: currentBlock.id ?? "_tool",
                name: currentBlock.name ?? "unknown_tool",
                arguments: currentBlock.arguments,
              };
            } else if (currentBlock?.type === "thinking") {
              assistantBlocks.push({
                type: "thinking",
                thinking: currentBlock.thinking,
                ...(currentBlock.signature ? { signature: currentBlock.signature } : {}),
              });
            } else if (currentBlock?.type === "redacted_thinking") {
              assistantBlocks.push(currentBlock);
            } else if (currentBlock?.type === "text" && currentBlock.text) {
              assistantBlocks.push(currentBlock);
            }
            currentBlock = null;
            break;

          case "message_delta":
            outputTokens = parsed.usage?.output_tokens ?? outputTokens;
            break;

          case "message_stop":
            if (assistantBlocks.length > 0) {
              yield {
                type: "provider_sidecar",
                providerSidecarData: {
                  anthropic: {
                    contentBlocks: assistantBlocks,
                  },
                },
              };
            }
            yield { type: "usage", inputTokens, outputTokens };
            break;
        }
      }
    },
  };
}

registerProvider("anthropic-messages", createAnthropicProvider);

export { createAnthropicProvider };
