#!/usr/bin/env tsx
/**
 * One-shot task runner — execute a task with LLM + tools, no brain required.
 *
 * Usage:
 *   npx tsx bin/run-task.ts "帮我创建一个名为coder的brain"
 *   npx tsx bin/run-task.ts --model gemini-2.5-flash "读取brains目录下的所有文件"
 */

import "../src/llm/gemini2.js";
import "../src/llm/gemini3.js";
import "../src/llm/anthropic.js";
import "../src/llm/openai-compat.js";
import "../src/llm/deepseek-reasoning.js";

import { resolve, dirname } from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ToolDefinition, ToolContext } from "../src/core/types.js";
import { createProvider, getModelSpec } from "../src/llm/provider.js";
import { filterTools, executeTool } from "../src/core/tool-executor.js";
import { PathManager } from "../src/fs/path-manager.js";
import { TerminalManager } from "../src/terminal/manager.js";
import { assembleResponse } from "../src/llm/stream.js";
import type { LLMMessage } from "../src/llm/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ── Parse CLI args ──

let model = "gemini-2.0-flash";
const taskParts: string[] = [];

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--model" && process.argv[i + 1]) {
    model = process.argv[++i];
  } else {
    taskParts.push(process.argv[i]);
  }
}

const task = taskParts.join(" ").trim();
if (!task) {
  console.error("Usage: npx tsx bin/run-task.ts [--model <model>] <task>");
  process.exit(1);
}

// ── Load global tools ──

async function loadGlobalTools(): Promise<ToolDefinition[]> {
  const toolsDir = resolve(PROJECT_ROOT, "tools");
  const files = await readdir(toolsDir);
  const tools: ToolDefinition[] = [];

  for (const f of files) {
    if (!f.endsWith(".ts")) continue;
    try {
      const mod = await import(resolve(toolsDir, f));
      if (mod.default?.name && mod.default?.execute) {
        tools.push(mod.default as ToolDefinition);
      }
    } catch (err) {
      console.error(`[run-task] failed to load tool: ${f}`, err);
    }
  }
  return tools;
}

// ── Main ──

async function main() {
  console.log(`[run-task] model=${model}`);
  console.log(`[run-task] task: ${task}\n`);

  const signal = AbortSignal.timeout(300_000);
  const pathManager = new PathManager(PROJECT_ROOT);
  const terminalManager = new TerminalManager(pathManager);

  const ctx: ToolContext = {
    signal,
    pathManager,
    terminalManager,
    workspace: resolve(PROJECT_ROOT, "brains"),
  };

  const allTools = await loadGlobalTools();
  const tools = filterTools(allTools, ctx);

  const provider = createProvider(model);

  const messages: LLMMessage[] = [
    { role: "user", content: task, ts: Date.now() },
  ];

  const maxIterations = 50;
  for (let i = 0; i < maxIterations; i++) {
    if (signal.aborted) break;

    const stream = provider.chatStream(messages, tools, signal);
    const response = await assembleResponse(stream);

    const content = typeof response.content === "string" ? response.content : "";

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
      ts: Date.now(),
    });

    if (content.trim()) {
      console.log(`\n${content}`);
    }

    if (!response.toolCalls?.length) break;

    for (const tc of response.toolCalls) {
      console.log(`  → ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)})`);
      const result = await executeTool(tc.name, tc.arguments, tools, ctx);
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      messages.push({
        role: "tool",
        content: resultStr,
        toolCallId: tc.id,
        ts: Date.now(),
      });
    }
  }

  console.log("\n[run-task] done.");
}

main().catch((err) => {
  console.error("[run-task] fatal:", err);
  process.exit(1);
});
