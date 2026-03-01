/** LLM Provider registry — config-driven adapter factory with fallback chain support */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSpec, BrainJson, ReasoningEffort } from "../core/types.js";
import type { LLMProvider } from "./types.js";

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

// ── Adapter Registry (keyed by api type, e.g. "google-generative-ai") ──

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

export function resolveModelParams(model: string, brainConfig?: BrainJson): ResolvedModelParams {
  const spec = getModelSpec(model);

  const temperature = brainConfig?.temperature ?? spec.defaultTemperature;
  const maxTokens = brainConfig?.maxTokens ?? spec.maxOutput;
  const reasoningEffort = spec.reasoning
    ? (brainConfig?.reasoningEffort ?? undefined)
    : undefined;
  const showThinking = brainConfig?.showThinking ?? false;

  return { temperature, maxTokens, reasoningEffort, showThinking };
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

export function createProvider(modelSpec: string, brainConfig?: BrainJson): LLMProvider {
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

  const params = resolveModelParams(model, brainConfig);

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

/** Try models in order; on pre-stream failure, fall back to the next model. */
export function createFallbackProvider(
  models: string[],
  brainConfig?: BrainJson,
  onFallback?: (from: string, to: string, error: Error) => void,
): LLMProvider {
  if (models.length === 0) throw new Error("No models specified for fallback chain");
  if (models.length === 1) return createProvider(models[0], brainConfig);

  return {
    async *chatStream(messages, tools, signal) {
      let lastError: Error | undefined;
      for (let i = 0; i < models.length; i++) {
        let chunksYielded = false;
        try {
          const provider = createProvider(models[i], brainConfig);
          for await (const chunk of provider.chatStream(messages, tools, signal)) {
            chunksYielded = true;
            yield chunk;
          }
          return;
        } catch (err: any) {
          if (chunksYielded) throw err; // mid-stream failure: propagate
          lastError = err;
          if (i < models.length - 1) {
            onFallback?.(models[i], models[i + 1], err);
          }
        }
      }
      throw lastError ?? new Error("All models in fallback chain failed");
    },
  };
}
