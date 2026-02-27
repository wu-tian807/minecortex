/** @desc LLM Provider 注册中心 — 配置驱动的适配器工厂 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMProviderInterface } from "../core/types.js";

// ── Types ────────────────────────────────────────────────────────

export interface ProviderFactoryOpts {
  apiKey: string;
  baseUrl?: string;
  authType?: string;
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

function getKeySearchPaths(): string[] {
  const paths: string[] = [];
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    paths.push(resolve(thisDir, "../../key/llm_key.json"));
  } catch { /* ESM resolution failed */ }
  paths.push(resolve(process.cwd(), "key/llm_key.json"));
  return paths;
}

function loadKeyFile(): Record<string, KeyEntry> {
  if (keyFileCache) return keyFileCache;
  for (const p of getKeySearchPaths()) {
    if (existsSync(p)) {
      try {
        keyFileCache = JSON.parse(readFileSync(p, "utf-8"));
        return keyFileCache!;
      } catch { /* malformed JSON */ }
    }
  }
  throw new Error("Missing key/llm_key.json — copy from llm_key.example.json");
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

export function createProvider(modelSpec: string): LLMProviderInterface {
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

  const provider = factory({
    apiKey: entry.api_key,
    baseUrl: entry.api_base,
    authType: entry.auth_type,
  });

  (provider as any)._model = model;
  return provider;
}
