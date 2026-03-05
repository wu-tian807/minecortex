/** @desc RendererEvent shapes and formatting for CLIRenderer */

import { C } from "./ansi.js";

// ─── Event shapes stored in events.jsonl ───

export type RendererEvent =
  | { k: "user_input";   text: string; ts: number }
  | { k: "brain_message"; source: string; text: string; ts: number }
  | { k: "assistant";    text?: string; thinking?: string; ts: number }
  | { k: "tool_call";    name: string; args: Record<string, unknown>; ts: number }
  | { k: "tool_result";  name: string; preview: string; durationMs: number; ts: number }
  | { k: "todo_update";  todos: Array<{ id: string; content: string; status: string }>; ts: number }
  // Transient turn boundaries — used for the thinking indicator, not displayed as content
  | { k: "turn_start"; ts: number }
  | { k: "turn_end";   ts: number };

// ─── Icons ───

export const STATUS_ICON: Record<string, string> = {
  pending:    "○",
  in_progress: "▶",
  completed:  "✓",
  cancelled:  "✗",
};

const TOOL_ICONS: Record<string, string> = {
  shell:        "$",
  read_file:    "📄",
  write_file:   "✏️",
  edit_file:    "✏️",
  glob:         "🔍",
  grep:         "🔍",
  web_search:   "🌐",
  web_fetch:    "🌐",
  spawn_thought: "🤖",
  todo_write:   "📋",
};

// ─── Helpers ───

function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();
}

// ─── Render a single event to a printable string (null = skip) ───

export function formatEvent(ev: RendererEvent): string | null {
  switch (ev.k) {
    case "user_input":
      return `${C.cyan}> ${ev.text}${C.reset}\n`;

    case "brain_message":
      return `${C.magenta}⟵ from \`${ev.source}\`:${C.reset} ${ev.text.slice(0, 200)}\n\n`;

    case "assistant": {
      const text = ev.text ? stripThinking(ev.text) : "";
      return text ? `${text}\n\n` : null;
    }

    case "tool_call": {
      if (ev.name === "spawn_thought") {
        const task = String(ev.args?.task ?? "");
        const type = String(ev.args?.type ?? "");
        const mode = String(ev.args?.mode ?? "background");
        return (
          `\n${C.magenta}┌─ ${C.bold}thought${C.reset} ${C.dim}(${type}, ${mode})${C.reset}\n` +
          `${C.magenta}│${C.reset}  ${C.dim}${task.slice(0, 80)}${C.reset}\n`
        );
      }
      const icon = TOOL_ICONS[ev.name] ?? "▸";
      const argsStr = JSON.stringify(ev.args);
      const preview = argsStr.length > 80 ? argsStr.slice(0, 77) + "..." : argsStr;
      return `  ${C.cyan}${icon} ${ev.name}${C.reset}${C.dim}(${preview})${C.reset}\n`;
    }

    case "tool_result": {
      if (ev.name === "spawn_thought") {
        let status = "completed";
        try {
          status = String((JSON.parse(ev.preview) as Record<string, unknown>)?.status ?? "completed");
        } catch { /* keep */ }
        const isError = status === "error";
        return (
          `${C.magenta}└─${C.reset} ${isError ? C.red : C.green}${isError ? "✗" : "✓"} ${status}${C.reset}` +
          ` ${C.dim}(${ev.durationMs}ms)${C.reset}\n\n`
        );
      }
      const oneliner = ev.preview.replace(/\n/g, " ");
      const display = oneliner.length > 200 ? oneliner.slice(0, 197) + "..." : oneliner;
      return `  ${C.dim}← ${ev.name} (${ev.durationMs}ms): ${display}${C.reset}\n`;
    }

    case "todo_update": {
      if (!ev.todos?.length) return null;
      const total = ev.todos.length;
      const done  = ev.todos.filter(t => t.status === "completed").length;
      const lines = ev.todos.map(t => `  ${STATUS_ICON[t.status] ?? "?"} [${t.id}] ${t.content}`);
      return `\n${C.dim}[todos] ${done}/${total}\n${lines.join("\n")}${C.reset}\n\n`;
    }

    case "turn_start":
    case "turn_end":
      return null; // handled by renderer state, not displayed as content

    default:
      return null;
  }
}
