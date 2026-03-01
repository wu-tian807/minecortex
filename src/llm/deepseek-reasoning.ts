/** DeepSeek reasoning adapter — extends openai-compat with reasoning_content extraction */

import { registerProvider, type ProviderFactoryOpts } from "./provider.js";
import type { LLMProvider } from "./types.js";
import { openAICompatStream } from "./openai-compat.js";

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
        messages,
        tools,
        signal,
      );
    },
  };
}

registerProvider("deepseek-reasoning", createDeepSeekReasoningProvider);

export { createDeepSeekReasoningProvider };
