/** 默认配置模板 */

import type { BrainJson, MineclawConfig, ModelSpec } from "../core/types.js";
import { BRAIN_DEFAULTS } from "./brain-defaults.js";

export const DEFAULT_BRAIN_JSON: BrainJson = {
  models: {
    showThinking: true,
  },
  coalesceMs: BRAIN_DEFAULTS.coalesceMs,
  maxIterations: BRAIN_DEFAULTS.maxIterations,
  subscriptions: { global: "none", enable: ["cli", "recorder"] },
  tools: { global: "all", disable: ["manage_brain"] },
  slots: { global: "all" },
  session: {
    keepToolResults: BRAIN_DEFAULTS.session.keepToolResults,
    keepMedias: BRAIN_DEFAULTS.session.keepMedias,
  },
  timezone: BRAIN_DEFAULTS.timezone,
};

export const DEFAULT_MINECLAW_JSON: MineclawConfig = {
  models: {
    model: "gemini-2.5-flash",
    maxRetries: 3,
    timeout: -1,
  },
};

export const DEFAULT_LLM_KEY_JSON = {
  "gemini-3": {
    api_key: "",
    api: "google-gemini-3",
    models: ["gemini-3.1-pro-preview"],
  },
  "gemini-2": {
    api_key: "",
    api: "google-gemini-2",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  "azure-claude": {
    api_key: "",
    api_base: "https://your-resource.services.ai.azure.com/anthropic/",
    api: "anthropic-messages",
    models: ["claude-sonnet-4-6"],
  },
  deepseek: {
    api_key: "",
    api_base: "https://api.deepseek.com",
    api: "openai-completions",
    models: ["deepseek-chat"],
  },
  qwen: {
    api_key: "",
    api_base: "https://dashscope.aliyuncs.com/compatible-mode",
    api: "openai-completions",
    models: ["qwen3.5-plus", "qwen-max", "qwen-plus"],
  },
};

export const DEFAULT_MODELS_JSON: Record<string, ModelSpec> = {
  "gemini-2.0-flash": {
    input: ["text", "image", "video", "audio"],
    reasoning: false,
    contextWindow: 1048576,
    maxOutput: 8192,
    defaultTemperature: 1.0,
    tokensPerChar: 0.25,
  },
  "gemini-2.5-flash": {
    input: ["text", "image", "video", "audio"],
    reasoning: true,
    contextWindow: 1048576,
    maxOutput: 65536,
    defaultTemperature: 1.0,
    tokensPerChar: 0.25,
  },
  "gemini-2.5-pro": {
    input: ["text", "image", "video", "audio"],
    reasoning: true,
    contextWindow: 1048576,
    maxOutput: 65536,
    defaultTemperature: 1.0,
    tokensPerChar: 0.25,
  },
  "gemini-2.5-flash-lite": {
    input: ["text", "image", "video", "audio"],
    reasoning: false,
    contextWindow: 1048576,
    maxOutput: 65536,
    defaultTemperature: 1.0,
    tokensPerChar: 0.25,
  },
  "gemini-3.1-pro-preview": {
    input: ["text", "image", "video", "audio"],
    reasoning: true,
    contextWindow: 1048576,
    maxOutput: 65536,
    defaultTemperature: 1.0,
    tokensPerChar: 0.25,
  },
  "claude-opus-4-6": {
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 200000,
    maxOutput: 128000,
    defaultTemperature: 1.0,
    tokensPerChar: 0.35,
  },
  "claude-sonnet-4-6": {
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 200000,
    maxOutput: 64000,
    defaultTemperature: 1.0,
    tokensPerChar: 0.35,
  },
  "qwen3.5:35b": {
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 262144,
    maxOutput: 8192,
    defaultTemperature: 1.0,
    tokensPerChar: 0.35,
  },
  "qwen3.5": {
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 262144,
    maxOutput: 8192,
    defaultTemperature: 1.0,
    tokensPerChar: 0.35,
  },
  "deepseek-chat": {
    input: ["text"],
    reasoning: false,
    contextWindow: 65536,
    maxOutput: 8192,
    defaultTemperature: 0.7,
    tokensPerChar: 0.35,
  },
};
