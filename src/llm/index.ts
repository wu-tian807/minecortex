/** LLM entry — imports trigger all adapter self-registration */

import "./gemini2.js";
import "./gemini3.js";
import "./anthropic.js";
import "./openai-compat.js";
import "./deepseek-reasoning.js";

export {
  createProvider,
  createFallbackProvider,
  registerProvider,
  parseModelSpec,
  getModelSpec,
  resolveModelParams,
  buildRetryOptions,
  type FallbackProviderOptions,
} from "./provider.js";
export { assembleResponse } from "./stream.js";
export { withRetry, type RetryOptions, type RetryInfo } from "./retry.js";
export {
  classifyLLMError,
  formatLLMError,
  isRetryable,
  getRecommendedDelay,
  TerminalLLMError,
  RetryableLLMError,
  NetworkError,
} from "./errors.js";
