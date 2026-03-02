/** @desc Stdout subscription — pipes assistant messages + tool activity to terminal */

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

      unsubs.push(ctx.hooks.on(HookEvent.AssistantMessage, ({ msg }) => {
        const raw = typeof msg.content === "string"
          ? msg.content
          : msg.content
              ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map(p => p.text)
              .join("") ?? "";
        const text = raw.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();

        if (msg.toolCalls?.length) {
          const calls = msg.toolCalls
            .map(tc => `  → ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 120)})`)
            .join("\n");
          const block = text ? `${text}\n${calls}` : calls;
          process.stdout.write(block + "\n");
          qa.recordAssistant(block).catch(() => {});
        } else if (text) {
          process.stdout.write(text + "\n");
          qa.recordAssistant(text).catch(() => {});
        }
      }));

      unsubs.push(ctx.hooks.on(HookEvent.ToolResult, ({ name, result, durationMs }) => {
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        const preview = resultStr.slice(0, 200);
        const suffix = resultStr.length > 200 ? "..." : "";
        const line = `  ← ${name} (${durationMs}ms): ${preview}${suffix}`;
        process.stdout.write(line + "\n");
        qa.recordToolResult(name, resultStr, durationMs).catch(() => {});
      }));

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
