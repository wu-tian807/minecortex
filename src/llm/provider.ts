/** @desc LLM Provider 注册中心 — 适配器工厂模式 */

import type { LLMProviderInterface, LLMMessage, LLMResponse, ToolDefinition } from "../core/types.js";

export interface ProviderFactoryOpts {
  apiKey: string;
}

type ProviderFactory = (opts: ProviderFactoryOpts) => LLMProviderInterface;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.set(name, factory);
}

const MODEL_PREFIX_MAP: Record<string, string> = {
  "gemini": "gemini",
  "claude": "anthropic",
};

function resolveProviderName(model: string): string {
  for (const [prefix, provider] of Object.entries(MODEL_PREFIX_MAP)) {
    if (model.startsWith(prefix)) return provider;
  }
  throw new Error(`No provider registered for model: ${model}`);
}

let keyCache: Record<string, string> | null = null;

async function loadKeys(): Promise<Record<string, string>> {
  if (keyCache) return keyCache;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const raw = await readFile(join(process.cwd(), "key", "llm_key.json"), "utf-8");
    keyCache = JSON.parse(raw);
    return keyCache!;
  } catch {
    throw new Error("Missing key/llm_key.json — copy from llm_key.example.json");
  }
}

export async function createProvider(model: string): Promise<LLMProviderInterface> {
  const providerName = resolveProviderName(model);
  const factory = registry.get(providerName);
  if (!factory) {
    throw new Error(`Provider '${providerName}' not registered. Available: ${[...registry.keys()].join(", ")}`);
  }
  const keys = await loadKeys();
  const apiKey = keys[providerName];
  if (!apiKey) {
    throw new Error(`No API key found for provider '${providerName}' in key/llm_key.json`);
  }
  return factory({ apiKey });
}
