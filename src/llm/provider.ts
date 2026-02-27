/** @desc LLM Provider 注册中心 — 配置驱动的适配器工厂 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMProviderInterface, ModelSpec, BrainJson, ReasoningEffort } from "../core/types.js";

// ── Types ────────────────────────────────────────────────────────

export interface ProviderFactoryOpts {
  apiKey: string;
  baseUrl?: string;
  authType?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
}

interface KeyEntry {
  api_key: string;
  api: string;
  models: string[];
  api_base?: string;
  auth_type?: string;
}

type ProviderFactory = (opts: ProviderFactoryOpts) => LLMProviderInterface;

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

let keyFileCache: Record<string, KeyEntry> | null = null;

function getKeyDir(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(thisDir, "../../key");
    if (existsSync(candidate)) return candidate;
  } catch { /* ESM resolution failed */ }
  return resolve(process.cwd(), "key");
}

function loadKeyFile(): Record<string, KeyEntry> {
  if (keyFileCache) return keyFileCache;
  const p = resolve(getKeyDir(), "llm_key.json");
  if (existsSync(p)) {
    try {
      keyFileCache = JSON.parse(readFileSync(p, "utf-8"));
      return keyFileCache!;
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

let modelCatalogCache: Record<string, ModelSpec> | null = null;

function loadModelCatalog(): Record<string, ModelSpec> {
  if (modelCatalogCache) return modelCatalogCache;
  const p = resolve(getKeyDir(), "models.json");
  if (existsSync(p)) {
    try {
      modelCatalogCache = JSON.parse(readFileSync(p, "utf-8"));
      return modelCatalogCache!;
    } catch { /* malformed JSON */ }
  }
  modelCatalogCache = {};
  return modelCatalogCache;
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
}

export function resolveModelParams(model: string, brainConfig?: BrainJson): ResolvedModelParams {
  const spec = getModelSpec(model);

  const temperature = brainConfig?.temperature ?? spec.defaultTemperature;
  const maxTokens = brainConfig?.maxTokens ?? spec.maxOutput;
  const reasoningEffort = spec.reasoning
    ? (brainConfig?.reasoningEffort ?? undefined)
    : undefined;

  return { temperature, maxTokens, reasoningEffort };
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

export function createProvider(modelSpec: string, brainConfig?: BrainJson): LLMProviderInterface {
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

  const provider = factory({
    apiKey: entry.api_key,
    baseUrl: entry.api_base,
    authType: entry.auth_type,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    reasoningEffort: params.reasoningEffort,
  });

  (provider as any)._model = model;
  return provider;
}
