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
  tokensPerChar: 0.3,
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
  /** 重试配置（会被 modelsConfig 中的配置覆盖） */
  retry?: RetryOptions;
  /** 重试回调（用于日志） */
  onRetry?: (model: string, info: RetryInfo) => void;
  /** 模型切换回调 */
  onFallback?: (from: string, to: string, error: Error) => void;
  /** LLM 调用超时（毫秒），-1 = 永不超时 */
  timeout?: number;
}

/**
 * 创建带重试和 fallback 的 provider
 *
 * 流程：
 * 1. 对每个模型，先通过 withRetry 重试
 * 2. 重试耗尽后，fallback 到下一个模型
 * 3. 流开始后（chunksYielded=true）不重试，直接抛出
 *
 * @param models 模型名称列表
 * @param modelsConfig 模型配置
 * @param options fallback 选项
 */
export function createFallbackProvider(
  models: string[],
  modelsConfig?: ModelsConfig,
  options?: FallbackProviderOptions,
): LLMProvider {
  if (models.length === 0) throw new Error("No models specified for fallback chain");

  // 从 modelsConfig 构建重试选项，与传入的 options.retry 合并
  const configRetryOpts = buildRetryOptions(modelsConfig);
  const retryOpts: RetryOptions = { ...options?.retry, ...configRetryOpts };
  const { onRetry, onFallback } = options ?? {};

  // 单模型：只需重试，无 fallback
  if (models.length === 1) {
    const provider = createProvider(models[0], modelsConfig);
    return {
      async *chatStream(messages, tools, signal) {
        const modelName = models[0];

        // 由于 chatStream 返回 AsyncGenerator，需要在外层包装重试
        // 这里采用"首次调用时重试"策略：获取第一个 chunk 前重试
        let chunksYielded = false;

        const createStream = () => provider.chatStream(messages, tools, signal);

        // 使用 withRetry 包装首次 chunk 获取
        const stream = await withRetry(
          async () => {
            const iterable = createStream();
            const iterator = iterable[Symbol.asyncIterator]();
            const first = await iterator.next();
            return { iterator, first };
          },
          {
            ...retryOpts,
            signal,
            onRetry: (info) => onRetry?.(modelName, info),
          },
        );

        // 处理首个 chunk
        if (!stream.first.done) {
          chunksYielded = true;
          yield stream.first.value;
        }

        // 流式处理剩余内容（不重试）
        try {
          let result = await stream.iterator.next();
          while (!result.done) {
            yield result.value;
            result = await stream.iterator.next();
          }
        } catch (err) {
          // 流中断：直接抛出，由上层处理
          const classified = classifyLLMError(err);
          throw classified.error;
        }
      },
    };
  }

  // 多模型：重试 + fallback
  return {
    async *chatStream(messages, tools, signal) {
      let lastError: Error | undefined;

      for (let i = 0; i < models.length; i++) {
        const modelName = models[i];
        let chunksYielded = false;

        try {
          const provider = createProvider(modelName, modelsConfig);
          const createStream = () => provider.chatStream(messages, tools, signal);

          // 使用 withRetry 包装首次 chunk 获取
          const stream = await withRetry(
            async () => {
              const iterable = createStream();
              const iterator = iterable[Symbol.asyncIterator]();
              const first = await iterator.next();
              return { iterator, first };
            },
            {
              ...retryOpts,
              signal,
              onRetry: (info) => onRetry?.(modelName, info),
            },
          );

          // 处理首个 chunk
          if (!stream.first.done) {
            chunksYielded = true;
            yield stream.first.value;
          }

          // 流式处理剩余内容
          let result = await stream.iterator.next();
          while (!result.done) {
            yield result.value;
            result = await stream.iterator.next();
          }

          return; // 成功完成
        } catch (err: unknown) {
          const classified = classifyLLMError(err);

          // 流已开始：不 fallback，直接抛出
          if (chunksYielded) {
            throw classified.error;
          }

          lastError = classified.error;

          // 通知 fallback（如果还有下一个模型）
          if (i < models.length - 1) {
            onFallback?.(modelName, models[i + 1], classified.error);
          }
        }
      }

      throw lastError ?? new Error("All models in fallback chain failed");
    },
  };
}
