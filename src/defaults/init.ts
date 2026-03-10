/** 配置文件初始化 — 确保必要的配置文件存在 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MINECORTEX_JSON,
  DEFAULT_LLM_KEY_JSON,
  DEFAULT_MODELS_JSON,
} from "./templates.js";

/**
 * 如果文件不存在则创建
 * @returns true 如果创建了文件
 */
async function ensureFile(path: string, content: unknown): Promise<boolean> {
  if (existsSync(path)) return false;
  await writeFile(path, JSON.stringify(content, null, 2) + "\n", "utf-8");
  return true;
}

/**
 * 确保目录存在
 */
async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * 确保所有默认配置文件存在
 * - minecortex.json
 * - key/llm_key.json
 * - key/models.json
 * - brains/ 目录
 */
export async function ensureDefaultConfigs(root: string): Promise<void> {
  await ensureDir(join(root, "key"));
  await ensureDir(join(root, "bundle", "brains"));

  if (await ensureFile(join(root, "minecortex.json"), DEFAULT_MINECORTEX_JSON)) {
    console.log("Created default minecortex.json");
  }

  if (await ensureFile(join(root, "key", "llm_key.json"), DEFAULT_LLM_KEY_JSON)) {
    console.log("Created default key/llm_key.json — please fill in your API keys");
  }

  if (await ensureFile(join(root, "key", "models.json"), DEFAULT_MODELS_JSON)) {
    console.log("Created default key/models.json");
  }
}
