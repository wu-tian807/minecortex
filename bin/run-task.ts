#!/usr/bin/env npx tsx
/**
 * @desc run-task — one-shot task runner using a temporary brain.
 *
 * Usage:
 *   npx tsx bin/run-task.ts "task description" [--id=brain-id] [--model=model-name]
 *
 * New task:  creates brain → sets brainBoard task-run=true → starts → pushes task → waits TurnEnd → frees
 * Resume:   --id=existing-brain-id → starts existing brain → pushes <CONTINUE> → waits TurnEnd → frees
 */

import "../src/llm/gemini2.js";
import "../src/llm/gemini3.js";
import "../src/llm/anthropic.js";
import "../src/llm/openai-compat.js";
import "../src/llm/deepseek-reasoning.js";

import { Scheduler } from "../src/core/scheduler.js";
import { HookEvent } from "../src/hooks/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function parseArgs() {
  const args = process.argv.slice(2);
  let task = "";
  let id: string | undefined;
  let model: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("--id=")) {
      id = arg.slice(5);
    } else if (arg.startsWith("--model=")) {
      model = arg.slice(8);
    } else if (!arg.startsWith("--")) {
      task = arg;
    }
  }

  return { task, id, model };
}

function generateTaskId(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `task_${Date.now()}_${rand}`;
}

const TASK_SOUL = (task: string) =>
  `# Task Runner\n\n你是一个一次性任务执行器。\n\n## 任务\n${task}\n\n## 约束\n- 专注完成给定任务\n- 完成后给出简洁的文字总结\n- 默认中文回复，代码注释用英文\n- 不要发起新的对话或等待输入\n`;

async function main() {
  const { task, id, model } = parseArgs();

  const brainId = id ?? generateTaskId();
  const isResume = id != null && existsSync(join(ROOT, "brains", brainId));

  if (!isResume && !task) {
    console.error("Usage: npx tsx bin/run-task.ts \"task description\" [--id=brain-id] [--model=model-name]");
    process.exit(1);
  }

  console.log(`[run-task] ${isResume ? "resuming" : "creating"} brain '${brainId}'`);

  const scheduler = new Scheduler();
  await scheduler.init();

  const board = scheduler.getBrainBoard();

  if (!isResume) {
    const result = await scheduler.controlBrain("create", brainId, {
      model: model ?? undefined,
      soul: TASK_SOUL(task),
      subscriptions: { global: "none" },
    });
    console.log(`[run-task] ${result}`);
  }

  board.set(brainId, "task-run", true);
  board.set(brainId, "task", task.slice(0, 500));

  const startResult = await scheduler.controlBrain("start", brainId);
  console.log(`[run-task] ${startResult}`);

  const managed = scheduler.getManagedBrain(brainId);
  if (!managed) {
    console.error(`[run-task] Failed to get managed brain for '${brainId}'`);
    process.exit(1);
  }

  const { queue, hooks } = managed;

  const done = new Promise<void>((resolve) => {
    hooks.on(HookEvent.TurnEnd, async ({ aborted }) => {
      console.log(`[run-task] turn ended${aborted ? " (aborted)" : ""}, freeing brain...`);
      await scheduler.controlBrain("free", brainId);
      resolve();
    });
  });

  if (isResume) {
    queue.push({
      source: "scheduler",
      type: "resume",
      payload: { prompt: "<CONTINUE>" },
      ts: Date.now(),
      priority: 0,
    });
    console.log("[run-task] pushed <CONTINUE>");
  } else {
    queue.push({
      source: "scheduler",
      type: "task",
      payload: { prompt: task },
      ts: Date.now(),
      priority: 0,
    });
    console.log("[run-task] pushed task event");
  }

  await done;
  console.log("[run-task] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[run-task] fatal:", err);
  process.exit(1);
});
