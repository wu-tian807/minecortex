/** @desc MineClaw 入口 — 注册 LLM 适配器，启动 Scheduler */

// Side-effect import: registers the gemini provider
import "./llm/gemini.js";

import { Scheduler } from "./core/scheduler.js";

async function main() {
  console.log("╔════════════════════════════════╗");
  console.log("║        MineClaw v0.1.0         ║");
  console.log("╚════════════════════════════════╝\n");

  const scheduler = new Scheduler();
  await scheduler.start();

  process.on("SIGINT", async () => {
    console.log("\n正在关闭...");
    await scheduler.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
