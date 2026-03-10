/** @desc RendererEvent shapes and formatting for CLIRenderer */

import { C } from "./ansi.js";
import { renderMarkdown } from "./markdown.js";

// ─── Event shapes stored in events.jsonl ───

export interface InputSegment {
  type: "text" | "paste";
  content: string;
}

export type RendererEvent =
  | { k: "user_input"; text: string; segments?: InputSegment[]; ts: number }
  | { k: "command"; brain: string; toolName: string; ts: number }
  | { k: "brain_message"; source: string; text: string; ts: number }
  | { k: "cli_message";  source: string; text: string; ts: number }
  | { k: "assistant_chunk"; brain?: string; kind: "text" | "thinking"; text: string; ts: number }
  | { k: "assistant";    brain?: string; text?: string; thinking?: string; ts: number }
  | { k: "tool_call";    brain?: string; name: string; args: Record<string, unknown>; ts: number }
  | { k: "tool_result";  brain?: string; name: string; preview: string; durationMs: number; ts: number }
  | { k: "todo_update";  todos: Array<{ id: string; content: string; status: string }>; ts: number }
  // Transient turn boundaries — used for the thinking indicator, not displayed as content
  | { k: "turn_start"; ts: number }
  | { k: "turn_end";   ts: number }
  /** Persisted when a turn ends with an LLM or tool error. */
  | { k: "error_event"; text: string; ts: number };

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
  subagent: "🤖",
  todo_write:   "📋",
};

// ─── Helpers ───

function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();
}

// ─── Parse a JSONL line into a RendererEvent (null = invalid) ───

export function parseRendererEvent(line: string): RendererEvent | null {
  try { return JSON.parse(line) as RendererEvent; }
  catch { return null; }
}

// ─── Render a single event to a printable string (null = skip) ───

export function formatEvent(ev: RendererEvent): string | null {
  switch (ev.k) {
    case "command":
      return `${C.dim}⌘ /${ev.toolName} 已发送给 ${ev.brain}${C.reset}\n`;

    case "user_input": {
      let display = "";
      if (ev.segments?.length) {
        for (const seg of ev.segments) {
          if (seg.type === "paste") {
            const lines = seg.content.split("\n").length;
            display += `\x1b[44;97m[已粘贴 ${lines} 行]\x1b[0m`;
          } else {
            display += seg.content;
          }
        }
      } else {
        display = ev.text;
      }
      return `${C.cyan}> ${display}${C.reset}\n`;
    }

    case "brain_message":
      return `${C.magenta}⟵ ${ev.source}:${C.reset} ${ev.text.slice(0, 200)}\n\n`;

    case "cli_message":
      return `${C.yellow}📨 ${ev.source}:${C.reset} ${ev.text.slice(0, 200)}\n\n`;

    case "assistant": {
      const text     = ev.text ? stripThinking(ev.text) : "";
      const thinking = ev.thinking?.trim();
      const tag      = ev.brain ? `${C.cyan}[${ev.brain}]${C.reset}` : "";
      let out = "";
      if (thinking) {
        const thinkingLines = thinking.split("\n").map(l => `${C.dim}  ${l}${C.reset}`).join("\n");
        out += `${C.dim}💭 thinking${tag ? " " + tag : ""}${C.reset}\n${thinkingLines}\n${C.dim}─────${C.reset}\n`;
      }
      if (text) {
        const rendered = renderMarkdown(text);
        out += tag ? `${tag}\n${rendered}\n` : `${rendered}\n`;
      }
      return out ? out + "\n" : null;
    }

    case "assistant_chunk":
      return null;

    case "tool_call": {
      const tag = ev.brain ? `${C.dim}${ev.brain}${C.reset} ` : "";
      if (ev.name === "subagent") {
        const task = String(ev.args?.task ?? "");
        const type = String(ev.args?.type ?? "");
        const mode = String(ev.args?.mode ?? "background");
        return (
          `\n${C.magenta}┌─ ${C.bold}subagent${C.reset} ${C.dim}(${type}, ${mode})${C.reset}\n` +
          `${C.magenta}│${C.reset}  ${C.dim}${task.slice(0, 80)}${C.reset}\n`
        );
      }
      const icon = TOOL_ICONS[ev.name] ?? "▸";
      const argsStr = JSON.stringify(ev.args);
      const preview = argsStr.length > 80 ? argsStr.slice(0, 77) + "..." : argsStr;
      return `  ${tag}${C.cyan}${icon} ${ev.name}${C.reset}${C.dim}(${preview})${C.reset}\n`;
    }

    case "tool_result": {
      const tag = ev.brain ? `${C.dim}${ev.brain} ${C.reset}` : "";
      if (ev.name === "subagent") {
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
      return `  ${tag}${C.dim}← ${ev.name} (${ev.durationMs}ms): ${display}${C.reset}\n`;
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

    case "error_event":
      return `${C.red}⚠ ${ev.text}${C.reset}\n\n`;

    default:
      return null;
  }
}
