/** @desc MineClaw 入口 — 注册所有 LLM 适配器，启动 Scheduler + CLIRenderer */

import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { installConsoleBridge } from "./core/logger.js";
import { getPathManager } from "./fs/index.js";

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
import { clearScreen } from "./cli/ansi.js";
import { ensureDefaultConfigs } from "./defaults/index.js";
import { getModelSpec } from "./llm/provider.js";

import { BundleManager } from "./bundle/manager.js";
import { initPathManager } from "./fs/index.js";

async function main() {
  process.stdout.write("╔════════════════════════════════╗\n");
  process.stdout.write("║        MineClaw v0.2.0         ║\n");
  process.stdout.write("╚════════════════════════════════╝\n\n");

  await ensureDefaultConfigs(process.cwd());
  
  // 初始化全局 PathManager
  initPathManager(process.cwd());

  // 初始化终端管理器和 bundle 环境
  const bundleManager = BundleManager.getInstance();
  try {
    await bundleManager.init();
  } catch (e: any) {
    if (e.message.includes("No bundle manifest found")) {
      // 触发 UI 让用户选择 Pack 或 Backup
      console.error("\n" + e.message);
      console.log("TODO: Please run a CLI setup command or select a bundle visually. For now, exiting.");
      process.exit(1);
    }
    throw e;
  }

  const scheduler = new Scheduler();
  await scheduler.start();

  const renderer = new CLIRenderer(process.cwd(), {
    // Expose eventBus.observe so the renderer can receive in-process live streaming events.
    observeEvents: (handler) => scheduler.observeEvents(handler),
    // Route user text only to the active brain selected in the renderer.
    onUserInput: (brainId, text) => {
      scheduler.emit({
        source: "user",
        type: "user_input",
        to: brainId,
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
        const brainJson = JSON.parse(readFileSync(join(getPathManager().local(brainId).root(), "brain.json"), "utf-8")) as {
          model?: string | string[];
          models?: { model?: string | string[] };
        };
        // Brain.json may omit the model field, inheriting from the global minecortex.json.
        // Fall back to the global model so contextWindow is always resolved.
        let rawModel: string | string[] | undefined = brainJson.models?.model ?? brainJson.model;
        if (!rawModel) {
          try {
            const globalJson = JSON.parse(readFileSync(getPathManager().global().minecortexConfig(), "utf-8")) as {
              models?: { model?: string | string[] };
            };
            rawModel = globalJson.models?.model;
          } catch { /* ignore */ }
        }
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

  let terminalCleaned = false;
  const cleanupTerminal = () => {
    if (terminalCleaned) return;
    terminalCleaned = true;
    renderer.stop();
    clearScreen();
  };

  process.once("exit", cleanupTerminal);
  process.once("uncaughtException", cleanupTerminal);
  process.once("unhandledRejection", cleanupTerminal);

  await renderer.start();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
