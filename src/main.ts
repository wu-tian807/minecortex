/** @desc MineClaw 入口 — 注册所有 LLM 适配器，启动 Scheduler + CLIRenderer */

import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { installConsoleBridge } from "./core/logger.js";

// Redirect stderr (logger output) to debug.log — keeps terminal clean for the renderer
const _debugLog = createWriteStream(join(process.cwd(), "debug.log"), { flags: "a" });
process.stderr.write = _debugLog.write.bind(_debugLog) as typeof process.stderr.write;
installConsoleBridge();

import "./llm/gemini2.js";
import "./llm/gemini3.js";
import "./llm/anthropic.js";
import "./llm/openai-compat.js";
import "./llm/deepseek-reasoning.js";

import { Scheduler } from "./core/scheduler.js";
import { ConsciousBrain } from "./core/brain.js";
import { CLIRenderer } from "./cli/renderer.js";
import { ensureDefaultConfigs } from "./defaults/index.js";
import { getModelSpec } from "./llm/provider.js";

async function main() {
  process.stdout.write("╔════════════════════════════════╗\n");
  process.stdout.write("║        MineClaw v0.2.0         ║\n");
  process.stdout.write("╚════════════════════════════════╝\n\n");

  await ensureDefaultConfigs(process.cwd());

  const scheduler = new Scheduler();
  await scheduler.start();

  const renderer = new CLIRenderer(process.cwd(), {
    // Route user text through EventBus — brain receives it via its registered queue
    onUserInput: (_brainId, text) => {
      scheduler.emit({
        source: "user",
        type: "user_input",
        to: "*",
        payload: { content: text },
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
    // Watch context usage ratio for the status bar ring indicator.
    // currentContextUsage is updated by the brain whenever the session switches or a
    // new LLM response arrives — no session-ID validation needed here.
    watchContextUsage: (brainId, cb) => {
      let contextWindow: number | null = null;
      try {
        const brainJson = JSON.parse(readFileSync(join(process.cwd(), "bundle", "brains", brainId, "brain.json"), "utf-8")) as {
          model?: string | string[];
          models?: { model?: string | string[] };
        };
        const rawModel  = brainJson.models?.model ?? brainJson.model;
        const modelName = Array.isArray(rawModel) ? rawModel[0] : rawModel;
        if (modelName) contextWindow = getModelSpec(modelName).contextWindow ?? null;
      } catch { /* ignore */ }

      const toRatio = (value: unknown): number | null => {
        const tokens = typeof value === "number" && value > 0 ? value : null;
        return tokens !== null && contextWindow ? tokens / contextWindow : null;
      };

      // Fire immediately with the persisted value (survives restarts via brainboard.json).
      const current = scheduler.getBrainBoard().get(brainId, "currentContextUsage");
      if (current !== undefined) cb(toRatio(current));

      return scheduler.getBrainBoard().watch(brainId, "currentContextUsage", (value) => {
        cb(toRatio(value));
      });
    },
  });
  await renderer.start();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
