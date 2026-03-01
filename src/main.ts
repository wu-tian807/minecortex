/** @desc MineClaw 入口 — 注册所有 LLM 适配器，启动 Scheduler */

import "./llm/gemini2.js";
import "./llm/gemini3.js";
import "./llm/anthropic.js";
import "./llm/openai-compat.js";
import "./llm/deepseek-reasoning.js";

import { Scheduler } from "./core/scheduler.js";

async function main() {
  console.log("╔════════════════════════════════╗");
  console.log("║        MineClaw v0.2.0         ║");
  console.log("╚════════════════════════════════╝\n");

  const scheduler = new Scheduler();
  await scheduler.start();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
