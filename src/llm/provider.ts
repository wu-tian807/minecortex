/** LLM Provider registry — config-driven adapter factory with fallback chain support */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSpec, ModelsConfig, ReasoningEffort } from "../core/types.js";
import type { LLMProvider } from "./types.js";
import { withRetry, type RetryOptions, type RetryInfo } from "./retry.js";
import { classifyLLMError } from "./errors.js";

// ── Types ────────────────────────────────────────────────────────

export interface ProviderFactoryOpts {
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  showThinking?: boolean;
}

interface KeyEntry {
  api_key: string;
  api: string;
  models: string[];
  api_base?: string;
}

type ProviderFactory = (opts: ProviderFactoryOpts) => LLMProvider;

// ── Adapter Registry (keyed by api type, e.g. "google-gemini-2") ──

const registry = new Map<string, ProviderFactory>();

export function registerProvider(apiType: string, factory: ProviderFactory): void {
  registry.set(apiType, factory);
}

// ── model@keySection syntax ──────────────────────────────────────

export function parseModelSpec(raw: string): { model: string; keySection?: string } {
  const at = raw.lastIndexOf("@");
  if (at > 0 && at < raw.length - 1) {
    return { model: raw.slice(0, at), keySection: raw.slice(at + 1) };
  }
  return { model: raw };
}

// ── Key file loading ─────────────────────────────────────────────

function getKeyDir(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(thisDir, "../../key");
    if (existsSync(candidate)) return candidate;
  } catch { /* ESM resolution failed */ }
  return resolve(process.cwd(), "key");
}

/** Always re-read from disk so key/model changes take effect without restart. */
function loadKeyFile(): Record<string, KeyEntry> {
  const p = resolve(getKeyDir(), "llm_key.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch { /* malformed JSON */ }
  }
  throw new Error("Missing key/llm_key.json — copy from llm_key.example.json");
}

// ── Model catalog loading (key/models.json) ──────────────────────

const DEFAULT_SPEC: ModelSpec = {
  input: ["text"],
  reasoning: false,
  contextWindow: 128000,
  maxOutput: 4096,
  defaultTemperature: 0.7,
};

/** Always re-read from disk so model spec changes take effect without restart. */
function loadModelCatalog(): Record<string, ModelSpec> {
  const p = resolve(getKeyDir(), "models.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch { /* malformed JSON */ }
  }
  return {};
}

export function getModelSpec(model: string): ModelSpec {
  const catalog = loadModelCatalog();
  return catalog[model] ?? DEFAULT_SPEC;
}

// ── Resolve final model params (models.json defaults + brain.json overrides) ──

export interface ResolvedModelParams {
  temperature: number;
  maxTokens: number;
  reasoningEffort?: ReasoningEffort;
  showThinking?: boolean;
}

/**
 * 解析模型参数
 * @param model 模型名称
 * @param modelsConfig 模型配置
 */
export function resolveModelParams(
  model: string,
  modelsConfig?: ModelsConfig,
): ResolvedModelParams {
  const spec = getModelSpec(model);

  const temperature = modelsConfig?.temperature ?? spec.defaultTemperature;
  const maxTokens = modelsConfig?.maxTokens ?? spec.maxOutput;
  const reasoningEffort = spec.reasoning
    ? (modelsConfig?.reasoningEffort ?? undefined)
    : undefined;
  const showThinking = modelsConfig?.showThinking ?? true;

  return { temperature, maxTokens, reasoningEffort, showThinking };
}

/**
 * 从 ModelsConfig 构建 RetryOptions
 */
export function buildRetryOptions(modelsConfig?: ModelsConfig): RetryOptions {
  const opts: RetryOptions = {};

  if (modelsConfig?.maxRetries !== undefined) {
    opts.maxRetries = modelsConfig.maxRetries;
  }
  if (modelsConfig?.baseDelayMs !== undefined) {
    opts.baseDelayMs = modelsConfig.baseDelayMs;
  }
  if (modelsConfig?.maxDelayMs !== undefined) {
    opts.maxDelayMs = modelsConfig.maxDelayMs;
  }

  return opts;
}

// ── Model → Section resolution (scan models arrays) ─────────────

function resolveSection(model: string): { sectionName: string; entry: KeyEntry } {
  const keys = loadKeyFile();
  for (const [name, entry] of Object.entries(keys)) {
    if (entry.models?.includes(model)) {
      return { sectionName: name, entry };
    }
  }
  throw new Error(
    `No key section contains model '${model}'. ` +
    `Add it to a section's "models" array in key/llm_key.json, ` +
    `or use "model@section" syntax to specify explicitly.`,
  );
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Merge two ModelsConfig objects, with override fields taking precedence.
 * Undefined values in override are ignored (base value is kept).
 */
export function mergeModelsConfig(base: ModelsConfig, override: ModelsConfig): ModelsConfig {
  const result = { ...base };
  for (const [k, v] of Object.entries(override) as [keyof ModelsConfig, unknown][]) {
    if (v !== undefined) (result as Record<string, unknown>)[k] = v;
  }
  return result;
}

/**
 * 创建单个模型的 Provider
 * @param modelSpec 模型名称（可带 @keySection 后缀）
 * @param modelsConfig 模型配置
 */
export function createProvider(
  modelSpec: string,
  modelsConfig?: ModelsConfig,
): LLMProvider {
  const { model, keySection } = parseModelSpec(modelSpec);

  let entry: KeyEntry;
  if (keySection) {
    const keys = loadKeyFile();
    entry = keys[keySection];
    if (!entry) {
      throw new Error(`Key section '${keySection}' not found in key/llm_key.json`);
    }
  } else {
    ({ entry } = resolveSection(model));
  }

  const apiType = entry.api;
  const factory = registry.get(apiType);
  if (!factory) {
    throw new Error(
      `No adapter registered for api type '${apiType}'. ` +
      `Available: ${[...registry.keys()].join(", ")}`,
    );
  }

  if (!entry.api_key) {
    throw new Error(`Empty api_key in key section for model '${model}'`);
  }

  const params = resolveModelParams(model, modelsConfig);

  return factory({
    model,
    apiKey: entry.api_key,
    baseUrl: entry.api_base,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    reasoningEffort: params.reasoningEffort,
    showThinking: params.showThinking,
  });
}

export interface FallbackProviderOptions {
  retry?: RetryOptions;
  onRetry?: (model: string, info: RetryInfo) => void;
  onFallback?: (from: string, to: string, error: Error) => void;
}

/**
 * 创建无状态的 fallback provider。
 *
 * 每次 chatStream 调用时从 getModelsConfig() 读取最新配置（模型列表、重试策略、
 * temperature 等），因此 brain.json 的修改无需重建 provider 即可生效。
 *
 * 流程：对每个模型先 withRetry 重试；重试耗尽后 fallback 到下一个；
 * 流开始后（已 yield chunk）不 fallback，直接抛出。
 */
export function createFallbackProvider(
  getModelsConfig: () => ModelsConfig,
  options?: FallbackProviderOptions,
): LLMProvider {
  const { onRetry, onFallback } = options ?? {};

  return {
    async *chatStream(messages, tools, signal) {
      const mc = getModelsConfig();
      const models = Array.isArray(mc.model) ? mc.model : [mc.model ?? ""];
      if (!models[0]) throw new Error("No model specified in ModelsConfig");

      const retryOpts: RetryOptions = { ...options?.retry, ...buildRetryOptions(mc) };
      let lastError: Error | undefined;

      for (let i = 0; i < models.length; i++) {
        const modelName = models[i];
        let chunksYielded = false;

        try {
          const provider = createProvider(modelName, mc);
          const stream = await withRetry(
            async () => {
              const it = provider.chatStream(messages, tools, signal)[Symbol.asyncIterator]();
              return { it, first: await it.next() };
            },
            { ...retryOpts, signal, onRetry: (info) => onRetry?.(modelName, info) },
          );

          if (!stream.first.done) { chunksYielded = true; yield stream.first.value; }

          for (let r = await stream.it.next(); !r.done; r = await stream.it.next()) {
            yield r.value;
          }
          return;
        } catch (err: unknown) {
          const classified = classifyLLMError(err);
          if (chunksYielded) throw classified.error;
          lastError = classified.error;
          if (i < models.length - 1) onFallback?.(modelName, models[i + 1], classified.error);
        }
      }

      throw lastError ?? new Error("All models in fallback chain failed");
    },
  };
}
