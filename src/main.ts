/** @desc MineClaw 入口 — 注册所有 LLM 适配器，启动 Scheduler + CLIRenderer */

import { createWriteStream } from "node:fs";
import { join } from "node:path";

// Redirect stderr (logger output) to debug.log — keeps terminal clean for the renderer
const _debugLog = createWriteStream(join(process.cwd(), "debug.log"), { flags: "a" });
process.stderr.write = _debugLog.write.bind(_debugLog) as typeof process.stderr.write;

import "./llm/gemini2.js";
import "./llm/gemini3.js";
import "./llm/anthropic.js";
import "./llm/openai-compat.js";
import "./llm/deepseek-reasoning.js";

import { Scheduler } from "./core/scheduler.js";
import { ConsciousBrain } from "./core/brain.js";
import { CLIRenderer } from "./cli/renderer.js";
import { ensureDefaultConfigs } from "./defaults/index.js";

async function main() {
  process.stdout.write("╔════════════════════════════════╗\n");
  process.stdout.write("║        MineClaw v0.2.0         ║\n");
  process.stdout.write("╚════════════════════════════════╝\n\n");

  await ensureDefaultConfigs(process.cwd());

  const scheduler = new Scheduler();
  await scheduler.start();

  const renderer = new CLIRenderer(process.cwd(), {
    // Route user text through EventBus — brain receives it via its registered queue
    onUserInput: (brainId, text) => {
      scheduler.emit({
        source: "user",
        type: "user_input",
        payload: { to: brainId, text },
        ts: Date.now(),
      });
    },
    // Brain commands (force-execute tool) still go directly to the brain
    onBrainCommand: (brainId, toolName, args) => {
      const brain = scheduler.getBrain(brainId);
      if (brain instanceof ConsciousBrain) {
        brain.queueCommand(toolName, args);
      }
    },
  });
  await renderer.start();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
