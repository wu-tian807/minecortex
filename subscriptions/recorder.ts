/** @desc Recorder subscription — pure event writer to events.jsonl + qa.md (no stdout) */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { readFileSync, watch as watchFs } from "node:fs";
import { join, dirname } from "node:path";
import type { Event, EventSource, SourceContext, BrainJson } from "../src/core/types.js";
import type { LLMMessage } from "../src/llm/types.js";
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

function formatTodoList(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) return "";
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => `  ${STATUS_ICON[t.status]} [${t.id}] ${t.content}`);
  return `[todos] ${done}/${total}\n${lines.join("\n")}`;
}

function getShowThinking(ctx: SourceContext): boolean {
  try {
    const raw = readFileSync(join(ctx.brain.brainDir, "brain.json"), "utf-8");
    const config = JSON.parse(raw) as BrainJson & { showThinking?: boolean };
    return config.showThinking === true || config.models?.showThinking === true;
  } catch {
    return false;
  }
}

class EventRecorder {
  private qaPath: string;
  private eventsPath: string | null = null;
  private brainDir: string | null = null;
  private currentSessionId: string | null = null;
  private sessionWatcher: ReturnType<typeof watchFs> | null = null;
  private dirCreated = false;
  private closed = false;
  private brainId: string;

  constructor(logDir: string, brainId: string) {
    this.qaPath = join(logDir, "qa.md");
    this.brainId = brainId;
  }

  async init(brainDir: string): Promise<void> {
    this.brainDir = brainDir;
    await this.ensureQaDir();
    let isResume = false;
    try {
      const sessionJson = JSON.parse(
        await readFile(join(brainDir, "session.json"), "utf-8")
      ) as { currentSessionId?: string };
      const sid = sessionJson.currentSessionId;
      if (sid) {
        this.currentSessionId = sid;
        this.eventsPath = join(brainDir, "sessions", sid, "events.jsonl");
        await mkdir(dirname(this.eventsPath), { recursive: true });
        try {
          const existing = await readFile(this.eventsPath, "utf-8");
          isResume = existing.trim().length > 0;
        } catch {
          await appendFile(this.eventsPath, "", "utf-8");
        }
      }
    } catch { /* no session yet */ }

    if (isResume) {
      await this.writeQA("\n---\n\n");
    }

    this.watchSessionJson();
  }

  private watchSessionJson(): void {
    if (!this.brainDir) return;
    const sessionJsonPath = join(this.brainDir, "session.json");
    let debounce: ReturnType<typeof setTimeout> | null = null;
    try {
      this.sessionWatcher = watchFs(sessionJsonPath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { this.onSessionJsonChange().catch(() => {}); }, 100);
      });
    } catch { /* file may not exist yet */ }
  }

  private async onSessionJsonChange(): Promise<void> {
    if (!this.brainDir || this.closed) return;
    try {
      const sessionJson = JSON.parse(
        await readFile(join(this.brainDir, "session.json"), "utf-8")
      ) as { currentSessionId?: string };
      const newSid = sessionJson.currentSessionId;
      if (!newSid || newSid === this.currentSessionId) return;

      this.currentSessionId = newSid;
      this.eventsPath = join(this.brainDir, "sessions", newSid, "events.jsonl");
      await mkdir(dirname(this.eventsPath), { recursive: true });
    } catch { /* ignore transient read errors */ }
  }

  private async ensureQaDir(): Promise<void> {
    if (this.dirCreated) return;
    await mkdir(dirname(this.qaPath), { recursive: true });
    this.dirCreated = true;
  }

  async writeQA(content: string): Promise<void> {
    if (this.closed) return;
    await this.ensureQaDir();
    await appendFile(this.qaPath, content, "utf-8");
  }

  async appendEvent(event: object): Promise<void> {
    if (this.closed || !this.eventsPath) return;
    await appendFile(this.eventsPath, JSON.stringify(event) + "\n", "utf-8");
  }

  // ─── Recorders ───

  recordUserInput(text: string): void {
    this.appendEvent({ k: "user_input", text, ts: Date.now() }).catch(() => {});
    this.writeQA(`## User\n${text}\n\n`).catch(() => {});
  }

  recordBrainMessage(source: string, text: string): void {
    this.appendEvent({ k: "brain_message", source, text, ts: Date.now() }).catch(() => {});
    this.writeQA(`> ⟵ from \`${source}\`: ${text}\n\n`).catch(() => {});
  }

  recordCliMessage(source: string, text: string): void {
    this.appendEvent({ k: "cli_message", source, text, ts: Date.now() }).catch(() => {});
    this.writeQA(`> 📨 \`${source}\` → cli: ${text}\n\n`).catch(() => {});
  }

  recordAssistantMessage(msg: LLMMessage): void {
    const raw = typeof msg.content === "string" ? msg.content : "";
    const text = raw.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();
    const thinking = msg.thinking ?? "";

    if (text || thinking) {
      let qaContent = `## Assistant\n\n`;
      if (thinking) {
        qaContent += `<details><summary>思考过程</summary>\n\n${thinking}\n\n</details>\n\n`;
      }
      if (text) {
        qaContent += `${text}\n\n`;
      }
      this.writeQA(qaContent).catch(() => {});
    }

    this.appendEvent({
      k: "assistant",
      brain: this.brainId,
      ...(text ? { text } : {}),
      ...(thinking ? { thinking } : {}),
      ts: Date.now(),
    }).catch(() => {});
  }

  recordToolCall(name: string, args: Record<string, unknown>): void {
    const icon = TOOL_ICONS[name] ?? "▸";
    const argsStr = JSON.stringify(args);
    const preview = argsStr.length > 120 ? argsStr.slice(0, 117) + "..." : argsStr;

    if (name === "spawn_thought") {
      const task = String(args.task ?? "");
      const type = String(args.type ?? "");
      this.writeQA(`> 🤖 \`spawn_thought\` (${type}): ${task.slice(0, 120)}\n\n`).catch(() => {});
    } else {
      this.writeQA(`> ${icon} \`${name}\`(${preview})\n`).catch(() => {});
    }
    this.appendEvent({ k: "tool_call", brain: this.brainId, name, args, ts: Date.now() }).catch(() => {});
  }

  recordToolResult(name: string, result: unknown, durationMs: number): void {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);

    if (name !== "spawn_thought") {
      const qaPreview = resultStr.length > 500 ? resultStr.slice(0, 497) + "..." : resultStr;
      this.writeQA(`\`\`\`\n${qaPreview}\n\`\`\`\n\n`).catch(() => {});
    } else {
      let status = "completed";
      try {
        const r = typeof result === "string" ? JSON.parse(result) : result as Record<string, unknown>;
        status = String((r as Record<string, unknown>)?.status ?? "completed");
      } catch { /* keep default */ }
      this.writeQA(`> spawn_thought ${status} (${durationMs}ms)\n\n`).catch(() => {});
    }

    const evPreview = resultStr.slice(0, 300);
    this.appendEvent({ k: "tool_result", brain: this.brainId, name, preview: evPreview, durationMs, ts: Date.now() }).catch(() => {});
  }

  recordTurnEnd(): void {
    this.appendEvent({ k: "turn_end", ts: Date.now() }).catch(() => {});
    this.writeQA("\n").catch(() => {});
  }

  recordTodoUpdate(todos: TodoItem[]): void {
    const formatted = formatTodoList(todos);
    if (!formatted) return;
    this.writeQA(`\n> **Todo 更新**\n\`\`\`\n${formatted}\n\`\`\`\n\n`).catch(() => {});
    this.appendEvent({ k: "todo_update", todos, ts: Date.now() }).catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.sessionWatcher?.close();
    this.sessionWatcher = null;
  }
}

export default function create(ctx: SourceContext): EventSource {
  const unsubs: (() => void)[] = [];
  const logsDir = ctx.brain.pathManager.logsDir(ctx.brain.id);
  const brainDir = ctx.brain.pathManager.brainDir(ctx.brain.id);
  const recorder = new EventRecorder(logsDir, ctx.brain.id);
  const _showThinking = getShowThinking(ctx);

  return {
    name: "recorder",

    start(_emit: (event: Event) => void) {
      recorder.init(brainDir).catch(() => {});

      // User input + inter-brain messages
      unsubs.push(
        ctx.brain.hooks.on(HookEvent.EventReceived, ({ events }) => {
          for (const e of events) {
            if (e.type === "user_input") {
              const text = (e.payload as { text?: string })?.text ?? "";
              recorder.recordUserInput(text);
            } else if (e.type === "message") {
              const payload = e.payload as { content?: string; summary?: string } | undefined;
              const text = payload?.content ?? JSON.stringify(e.payload);
              recorder.recordBrainMessage(e.source, text);
            }
          }
        })
      );

      unsubs.push(
        ctx.brain.hooks.on(HookEvent.AssistantMessage, ({ msg }) =>
          recorder.recordAssistantMessage(msg)
        )
      );

      unsubs.push(
        ctx.brain.hooks.on(HookEvent.ToolCall, ({ name, args }) =>
          recorder.recordToolCall(name, args)
        )
      );

      unsubs.push(
        ctx.brain.hooks.on(HookEvent.ToolResult, ({ name, result, durationMs }) =>
          recorder.recordToolResult(name, result, durationMs)
        )
      );

      unsubs.push(ctx.brain.hooks.on(HookEvent.TurnStart, () =>
        recorder.appendEvent({ k: "turn_start", ts: Date.now() }).catch(() => {})
      ));

      unsubs.push(ctx.brain.hooks.on(HookEvent.TurnEnd, () => recorder.recordTurnEnd()));

      // Messages addressed to "cli" (user) — observed globally since they don't enter any brain queue
      unsubs.push(
        ctx.brain.eventBus.observe((e) => {
          if (e.type === "message" && e.to === "cli") {
            const payload = e.payload as { content?: string; summary?: string } | undefined;
            const text = payload?.content ?? JSON.stringify(e.payload);
            recorder.recordCliMessage(e.source, text);
          }
        })
      );

      // BrainBoard reactive todo state
      unsubs.push(
        ctx.brain.brainBoard.watch(ctx.brain.id, "todo-list", (value) => {
          const todos = value as TodoItem[] | undefined;
          if (todos) recorder.recordTodoUpdate(todos);
        })
      );
    },

    stop() {
      for (const u of unsubs) u();
      unsubs.length = 0;
      recorder.close();
    },
  };
}
