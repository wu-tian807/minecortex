/** @desc Stdout subscription — CLI renderer + qa.md writer */

import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Event, EventSource, SourceContext, BrainJson } from "../src/core/types.js";
import { HookEvent } from "../src/hooks/types.js";

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

const TOOL_ICONS: Record<string, string> = {
  shell: "$",
  read_file: "📄",
  write_file: "✏️",
  edit_file: "✏️",
  glob: "🔍",
  grep: "🔍",
  web_search: "🌐",
  web_fetch: "🌐",
  spawn_thought: "🤖",
  todo_write: "📋",
};

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
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
  return `[todos] ${done}/${total}\n${lines.join("\n")}`;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

class CLIRenderer {
  private qaPath: string;
  private dirCreated = false;
  private streaming = false;
  private streamedText = "";
  private pendingToolCalls = false;
  private closed = false;

  constructor(logDir: string) {
    this.qaPath = join(logDir, "qa.md");
  }

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;
    await mkdir(dirname(this.qaPath), { recursive: true });
    this.dirCreated = true;
  }

  private async writeQA(content: string): Promise<void> {
    if (this.closed) return;
    await this.ensureDir();
    await appendFile(this.qaPath, content, "utf-8");
  }

  onTurnStart(): void {
    this.streaming = true;
    this.streamedText = "";
    this.pendingToolCalls = false;
  }

  onUserInput(text: string): void {
    process.stdout.write(`${C.cyan}> ${text}${C.reset}\n`);
    this.writeQA(`## User\n${text}\n\n`).catch(() => {});
  }

  onStreamChunk(chunk: { type: string; text?: string }): void {
    if (!this.streaming) return;
    if (chunk.type === "text" && chunk.text) {
      process.stdout.write(chunk.text);
      this.streamedText += chunk.text;
    }
  }

  onThinkingChunk(text: string, showThinking: boolean): void {
    if (showThinking) {
      process.stdout.write(`${C.dim}${text}${C.reset}`);
    }
  }

  onToolCall(name: string, args: unknown): void {
    if (this.streamedText && !this.streamedText.endsWith("\n")) {
      process.stdout.write("\n");
    }
    const icon = TOOL_ICONS[name] ?? "▸";
    const argsStr = JSON.stringify(args);
    const preview = argsStr.length > 80 ? argsStr.slice(0, 77) + "..." : argsStr;
    const line = `  ${C.cyan}${icon} ${name}${C.reset}${C.dim}(${preview})${C.reset}\n`;
    process.stdout.write(line);
    this.writeQA(`> ${icon} \`${name}\`\n`).catch(() => {});
    this.pendingToolCalls = true;
  }

  onToolResult(name: string, result: unknown, durationMs: number): void {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    const preview = resultStr.length > 200 ? resultStr.slice(0, 197) + "..." : resultStr;
    const displayPreview = preview.replace(/\n/g, " ");
    const line = `  ${C.dim}← ${name} (${durationMs}ms): ${displayPreview}${C.reset}\n`;
    process.stdout.write(line);

    const qaPreview = resultStr.length > 500 ? resultStr.slice(0, 497) + "..." : resultStr;
    this.writeQA(`\`\`\`\n${qaPreview}\n\`\`\`\n\n`).catch(() => {});
  }

  onTurnEnd(): void {
    if (this.streaming && this.streamedText) {
      const clean = this.streamedText
        .replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "")
        .trim();
      if (clean) {
        this.writeQA(`## Assistant\n${clean}\n\n`).catch(() => {});
      }
    }
    if (!this.streamedText.endsWith("\n")) {
      process.stdout.write("\n");
    }
    process.stdout.write("\n");
    this.streaming = false;
    this.streamedText = "";
    this.pendingToolCalls = false;
  }

  onTodoUpdate(todos: TodoItem[]): void {
    const formatted = formatTodoList(todos);
    if (formatted) {
      process.stdout.write(`\n${C.dim}${formatted}${C.reset}\n\n`);
    }
  }

  onSpawnThoughtStart(task: string): void {
    process.stdout.write(`\n${C.magenta}┌─ ${C.bold}thought${C.reset}${C.dim}\n`);
    process.stdout.write(`${C.magenta}│${C.reset}  ${C.dim}${task.slice(0, 80)}${C.reset}\n`);
  }

  onSpawnThoughtEnd(status: "completed" | "error", summary?: string): void {
    const icon = status === "completed" ? "✓" : "✗";
    const color = status === "completed" ? C.green : C.red;
    process.stdout.write(`${C.magenta}└─${C.reset} ${color}${icon}${C.reset}\n\n`);
    if (summary) {
      this.writeQA(`> 🤖 spawn_thought: ${summary.slice(0, 200)}\n\n`).catch(() => {});
    }
  }

  close(): void {
    this.closed = true;
  }
}

export default function create(ctx: SourceContext): EventSource {
  const unsubs: (() => void)[] = [];
  const renderer = new CLIRenderer(join(ctx.brainDir, "logs"));

  return {
    name: "stdout",

    start(_emit: (event: Event) => void) {
      if (!brainHasStdin(ctx)) return;

      unsubs.push(ctx.hooks.on(HookEvent.EventReceived, ({ events }) => {
        for (const e of events) {
          if (e.source === "stdin" && e.type === "user_input") {
            const text = (e.payload as { text?: string })?.text ?? "";
            renderer.onUserInput(text);
          }
        }
      }));

      unsubs.push(ctx.hooks.on(HookEvent.TurnStart, () => {
        renderer.onTurnStart();
      }));

      unsubs.push(ctx.hooks.on(HookEvent.StreamChunk, ({ chunk }) => {
        renderer.onStreamChunk(chunk);
      }));

      unsubs.push(ctx.hooks.on(HookEvent.ToolCall, ({ name, args }) => {
        renderer.onToolCall(name, args);
      }));

      unsubs.push(ctx.hooks.on(HookEvent.ToolResult, ({ name, result, durationMs }) => {
        renderer.onToolResult(name, result, durationMs);
      }));

      unsubs.push(ctx.hooks.on(HookEvent.TurnEnd, () => {
        renderer.onTurnEnd();
      }));

      const unwatchTodos = ctx.brainBoard.watch(ctx.brainId, "todo-list", (value) => {
        const todos = value as TodoItem[] | undefined;
        if (todos) renderer.onTodoUpdate(todos);
      });
      unsubs.push(unwatchTodos);
    },

    stop() {
      for (const u of unsubs) u();
      unsubs.length = 0;
      renderer.close();
    },
  };
}
