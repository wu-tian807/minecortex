/** @desc Stdout subscription — streaming assistant output + tool activity to terminal */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event, EventSource, SourceContext, BrainJson } from "../src/core/types.js";
import { HookEvent } from "../src/hooks/types.js";
import { QARecorder } from "../src/session/qa-recorder.js";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  cancelled: "✗",
};

function brainHasStdin(ctx: SourceContext): boolean {
  try {
    const raw = readFileSync(join(ctx.brainDir, "brain.json"), "utf-8");
    const config: BrainJson = JSON.parse(raw);
    const sub = config.subscriptions;
    if (!sub) return true;
    if (sub.global === "all") {
      return !(sub.disable ?? []).includes("stdin");
    }
    return (sub.enable ?? []).includes("stdin");
  } catch {
    return true;
  }
}

function formatTodoList(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) return "";
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => `  ${STATUS_ICON[t.status]} [${t.id}] ${t.content}`);
  return `[todos] ${done}/${total} completed\n${lines.join("\n")}`;
}

export default function create(ctx: SourceContext): EventSource {
  const unsubs: (() => void)[] = [];
  const qa = new QARecorder(join(ctx.brainDir, "logs"));

  return {
    name: "stdout",

    start(_emit: (event: Event) => void) {
      if (!brainHasStdin(ctx)) return;

      // ─── Streaming state ───
      let streaming = false;
      let streamedText = "";
      let pendingToolCalls = false;

      // TurnStart: prepare for streaming
      unsubs.push(ctx.hooks.on(HookEvent.TurnStart, () => {
        streaming = true;
        streamedText = "";
        pendingToolCalls = false;
      }));

      // StreamChunk: real-time text output
      unsubs.push(ctx.hooks.on(HookEvent.StreamChunk, ({ chunk }) => {
        if (!streaming) return;

        if (chunk.type === "text") {
          process.stdout.write(chunk.text);
          streamedText += chunk.text;
        }
      }));

      // ToolCall: show tool indicator, pause text streaming
      unsubs.push(ctx.hooks.on(HookEvent.ToolCall, ({ name, args }) => {
        if (streamedText && !streamedText.endsWith("\n")) {
          process.stdout.write("\n");
        }
        const argsPreview = JSON.stringify(args).slice(0, 80);
        process.stdout.write(`\x1b[90m  → ${name}(${argsPreview})\x1b[0m\n`);
        pendingToolCalls = true;
      }));

      // ToolResult: show result preview
      unsubs.push(ctx.hooks.on(HookEvent.ToolResult, ({ name, result, durationMs }) => {
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        const preview = resultStr.slice(0, 200);
        const suffix = resultStr.length > 200 ? "..." : "";
        process.stdout.write(`\x1b[90m  ← ${name} (${durationMs}ms): ${preview}${suffix}\x1b[0m\n`);
        qa.recordToolResult(name, resultStr, durationMs).catch(() => {});
      }));

      // TurnEnd: finalize and record
      unsubs.push(ctx.hooks.on(HookEvent.TurnEnd, () => {
        if (streaming && streamedText) {
          const clean = streamedText.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();
          if (clean) {
            qa.recordAssistant(clean).catch(() => {});
          }
        }
        // Always ensure newline at turn end
        process.stdout.write("\n");
        streaming = false;
        streamedText = "";
        pendingToolCalls = false;
      }));

      // Watch todo-list changes
      const unwatchTodos = ctx.brainBoard.watch(ctx.brainId, "todo-list", (value) => {
        const todos = value as TodoItem[] | undefined;
        const formatted = formatTodoList(todos ?? []);
        if (formatted) {
          process.stdout.write("\n" + formatted + "\n\n");
        }
      });
      unsubs.push(unwatchTodos);
    },

    stop() {
      for (const u of unsubs) u();
      unsubs.length = 0;
      qa.close();
    },
  };
}
