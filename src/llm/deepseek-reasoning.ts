/** DeepSeek reasoning adapter — extends openai-compat with reasoning_content extraction */

import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { LLMMessage, LLMProvider } from "./types.js";
import { openAICompatStream } from "./openai-compat.js";

/** Strip thinking from previous assistant turns to avoid confusing the model on tool-loop passback. */
function clearPreviousReasoning(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.thinking) {
      return { ...m, thinking: undefined };
    }
    return m;
  });
}

function normalizeBaseUrl(url: string): string {
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url;
}

function createDeepSeekReasoningProvider(
  opts: ProviderFactoryOpts,
): LLMProvider {
  return {
    async *chatStream(messages, tools, signal) {
      const cleaned = clearPreviousReasoning(messages);
      yield* openAICompatStream(
        {
          model: opts.model,
          apiKey: opts.apiKey,
          baseUrl: normalizeBaseUrl(
            opts.baseUrl ?? "https://api.deepseek.com",
          ),
          temperature: opts.temperature ?? 0.7,
          maxTokens: opts.maxTokens,
          reasoningEffort: opts.reasoningEffort,
          extractReasoning: true,
          useThinkTags: false,
        },
        cleaned,
        tools,
        signal,
      );
    },
  };
}

registerProvider("deepseek-reasoning", createDeepSeekReasoningProvider);

export { createDeepSeekReasoningProvider };
