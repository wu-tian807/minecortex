/** @desc CLIRenderer — interactive terminal renderer that tails events.jsonl */

import * as readline from "node:readline";
import { watch, readFileSync, existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../core/command-parser.js";

// ─── Helpers ───

function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();
}

// ─── ANSI colors ───

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
};

// ─── Callbacks wired by main.ts ───

export interface RendererCallbacks {
  /** Send plain user text to the active brain */
  onUserInput(brainId: string, text: string): void;
  /** Route a slash command (non-renderer) to the active brain */
  onBrainCommand(brainId: string, toolName: string, args: Record<string, string>): void;
}

// ─── mineclaw.json renderer state ───

interface MineclawJson {
  renderer?: { activeBrain?: string; activeSession?: string };
  [key: string]: unknown;
}

// ─── Event shapes from events.jsonl ───

type RendererEvent =
  | { k: "user_input"; text: string; ts: number }
  | { k: "brain_message"; source: string; text: string; ts: number }
  | { k: "assistant"; text?: string; thinking?: string; ts: number }
  | { k: "tool_call"; name: string; args: Record<string, unknown>; ts: number }
  | { k: "tool_result"; name: string; preview: string; durationMs: number; ts: number }
  | { k: "todo_update"; todos: Array<{ id: string; content: string; status: string }>; ts: number };

const STATUS_ICON: Record<string, string> = {
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

// ─── Render a single event — returns the string to print (or null to skip) ───

function formatEvent(ev: RendererEvent): string | null {
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
        try { status = String((JSON.parse(ev.preview) as Record<string, unknown>)?.status ?? "completed"); } catch { /* keep */ }
        const isError = status === "error";
        return `${C.magenta}└─${C.reset} ${isError ? C.red : C.green}${isError ? "✗" : "✓"} ${status}${C.reset} ${C.dim}(${ev.durationMs}ms)${C.reset}\n\n`;
      }
      const oneliner = ev.preview.replace(/\n/g, " ");
      const display = oneliner.length > 200 ? oneliner.slice(0, 197) + "..." : oneliner;
      return `  ${C.dim}← ${ev.name} (${ev.durationMs}ms): ${display}${C.reset}\n`;
    }

    case "todo_update": {
      if (!ev.todos?.length) return null;
      const total = ev.todos.length;
      const done = ev.todos.filter((t) => t.status === "completed").length;
      const lines = ev.todos.map((t) => `  ${STATUS_ICON[t.status] ?? "?"} [${t.id}] ${t.content}`);
      return `\n${C.dim}[todos] ${done}/${total}\n${lines.join("\n")}${C.reset}\n\n`;
    }

    default:
      return null;
  }
}

// ─── Filesystem helpers (no scheduler dependency) ───

async function listBrainIds(rootDir: string): Promise<string[]> {
  try {
    const brainsDir = join(rootDir, "brains");
    const entries = await readdir(brainsDir, { withFileTypes: true });
    const ids: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() && existsSync(join(brainsDir, e.name, "brain.json"))) {
        ids.push(e.name);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

async function listSessionIds(rootDir: string, brainId: string): Promise<string[]> {
  try {
    const sessionsDir = join(rootDir, "brains", brainId, "sessions");
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ─── CLIRenderer ───

const PROMPT = `${C.cyan}›${C.reset} `;

export class CLIRenderer {
  private rootDir: string;
  private configPath: string;
  private callbacks: RendererCallbacks;
  private activeBrain = "";
  private activeSession = "";
  private tailOffset = 0;
  private fsWatcher: ReturnType<typeof watch> | null = null;
  private stopped = false;
  private isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // raw mode input state
  private inputBuffer = "";
  private inputHistory: string[] = [];
  private historyIdx = -1;
  private escapeSeq = "";

  constructor(rootDir: string, callbacks: RendererCallbacks) {
    this.rootDir = rootDir;
    this.configPath = join(rootDir, "mineclaw.json");
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    await this.resolveActive();
    this.startStdin();
    await this.replayAndTail();
  }

  stop(): void {
    this.stopped = true;
    this.fsWatcher?.close();
    if (this.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
  }

  // ─── Output: clears input line, writes content, redraws prompt ───
  // This is safe regardless of what else writes to stdout — as long as we
  // redraw the prompt after, the input line is always current.
  // If logger also writes to stdout (no redirect), their output appears above
  // the prompt on the next redraw. The professional solution for zero conflict
  // is an alternate screen buffer (\x1b[?1049h), but that loses scrollback.
  // Current tradeoff: redirect stderr to debug.log (already done in main.ts).

  private print(text: string): void {
    if (!text) return;
    if (this.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(text);
      this.redrawPrompt();
    } else {
      process.stdout.write(text);
    }
  }

  private printEvent(ev: RendererEvent): void {
    const text = formatEvent(ev);
    if (text) this.print(text);
  }

  // ─── Config ───

  private readConfig(): MineclawJson {
    try {
      return JSON.parse(readFileSync(this.configPath, "utf-8")) as MineclawJson;
    } catch {
      return {};
    }
  }

  private async writeConfig(renderer: { activeBrain?: string; activeSession?: string }): Promise<void> {
    const current = this.readConfig();
    const updated = { ...current, renderer: { ...current.renderer, ...renderer } };
    await writeFile(this.configPath, JSON.stringify(updated, null, 2), "utf-8");
  }

  // ─── Resolve active brain + session ───

  private async resolveActive(): Promise<void> {
    const config = this.readConfig();
    let brain = config.renderer?.activeBrain ?? "";
    let session = config.renderer?.activeSession ?? "";

    const brainIds = await listBrainIds(this.rootDir);
    if (!brain || !brainIds.includes(brain)) brain = brainIds[0] ?? "";
    if (brain) {
      const sessions = await listSessionIds(this.rootDir, brain);
      if (!session || !sessions.includes(session)) session = sessions[0] ?? "";
    }

    this.activeBrain = brain;
    this.activeSession = session;
    if (brain && session) await this.writeConfig({ activeBrain: brain, activeSession: session });
  }

  private eventsPath(): string {
    return join(this.rootDir, "brains", this.activeBrain, "sessions", this.activeSession, "events.jsonl");
  }

  // ─── Replay + tail ───

  private async replayAndTail(): Promise<void> {
    if (!this.activeBrain || !this.activeSession) {
      this.print(`${C.dim}没有可用的 brain/session，使用 /brains 查看${C.reset}\n`);
      return;
    }

    this.print(`${C.dim}brain: ${this.activeBrain}  session: ${this.activeSession}${C.reset}\n\n`);

    const path = this.eventsPath();
    if (existsSync(path)) {
      const raw = await readFile(path, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { this.printEvent(JSON.parse(line) as RendererEvent); } catch { /* skip */ }
      }
      this.tailOffset = Buffer.byteLength(raw, "utf-8");
    }

    this.startTail();
  }

  private startTail(): void {
    this.fsWatcher?.close();
    const path = this.eventsPath();
    if (!existsSync(path)) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    this.fsWatcher = watch(path, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => this.readNewLines(), 50);
    });
  }

  private async readNewLines(): Promise<void> {
    try {
      const raw = await readFile(this.eventsPath(), "utf-8");
      const bytes = Buffer.byteLength(raw, "utf-8");
      if (bytes <= this.tailOffset) return;
      const slice = Buffer.from(raw, "utf-8").slice(this.tailOffset).toString("utf-8");
      this.tailOffset = bytes;
      for (const line of slice.split("\n")) {
        if (!line.trim()) continue;
        try { this.printEvent(JSON.parse(line) as RendererEvent); } catch { /* skip */ }
      }
    } catch { /* file not ready */ }
  }

  // ─── Switch session ───

  private async switchTo(brainId: string, sessionId: string): Promise<void> {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    this.tailOffset = 0;
    this.activeBrain = brainId;
    this.activeSession = sessionId;
    await this.writeConfig({ activeBrain: brainId, activeSession: sessionId });
    await this.replayAndTail();
  }

  // ─── Raw mode prompt ───

  private redrawPrompt(): void {
    if (!this.isTTY) return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(PROMPT + this.inputBuffer);
  }

  // ─── Interactive stdin — raw mode (TTY) or line mode (piped) ───

  private startStdin(): void {
    if (this.isTTY) {
      this.startRawMode();
    } else {
      this.startLineMode();
    }
  }

  // Raw mode: character-by-character, no readline buffering.
  // Gives full control: immediate keystrokes, arrows for history, Ctrl+U to clear.
  private startRawMode(): void {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    this.redrawPrompt();

    let awaitingChoice: Array<{ brain: string; session: string }> | null = null;

    process.stdin.on("data", (chunk: string) => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        const code = ch.charCodeAt(0);

        // Accumulate escape sequences (arrow keys etc.)
        if (this.escapeSeq) {
          this.escapeSeq += ch;
          if (this.escapeSeq === "\x1b[A") {        // ↑ history prev
            this.historyIdx = Math.min(this.historyIdx + 1, this.inputHistory.length - 1);
            this.inputBuffer = this.inputHistory[this.inputHistory.length - 1 - this.historyIdx] ?? "";
            this.redrawPrompt();
            this.escapeSeq = "";
          } else if (this.escapeSeq === "\x1b[B") { // ↓ history next
            this.historyIdx = Math.max(this.historyIdx - 1, -1);
            this.inputBuffer = this.historyIdx < 0 ? "" : (this.inputHistory[this.inputHistory.length - 1 - this.historyIdx] ?? "");
            this.redrawPrompt();
            this.escapeSeq = "";
          } else if (this.escapeSeq.length > 6 || (this.escapeSeq.length > 2 && !/^\x1b\[[\d;]*$/.test(this.escapeSeq))) {
            this.escapeSeq = ""; // unknown sequence, discard
          }
          continue;
        }

        if (code === 27) {             // ESC — start escape sequence
          this.escapeSeq = "\x1b";
        } else if (code === 3) {       // Ctrl+C
          process.stdout.write("\n");
          process.exit(0);
        } else if (code === 4) {       // Ctrl+D
          if (this.inputBuffer.length === 0) { process.stdout.write("\n"); process.exit(0); }
        } else if (code === 21) {      // Ctrl+U — clear line
          this.inputBuffer = "";
          this.redrawPrompt();
        } else if (code === 127 || code === 8) { // Backspace
          if (this.inputBuffer.length > 0) {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
            this.redrawPrompt();
          }
        } else if (code === 13 || code === 10) { // Enter
          const text = this.inputBuffer.trim();
          this.inputBuffer = "";
          this.historyIdx = -1;
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write("\n");
          if (text) {
            if (this.inputHistory[this.inputHistory.length - 1] !== text) {
              this.inputHistory.push(text);
            }
            this.handleLine(text, awaitingChoice).then((next) => {
              awaitingChoice = next;
              this.redrawPrompt();
            });
          } else {
            this.redrawPrompt();
          }
        } else if (code >= 32) {       // Printable character
          this.inputBuffer += ch;
          process.stdout.write(ch);    // echo inline (cursor already at end)
        }
      }
    });

    process.stdin.on("end", () => { if (!this.stopped) process.exit(0); });
  }

  // Line mode: for non-TTY (piped input / scripts).
  private startLineMode(): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let awaitingChoice: Array<{ brain: string; session: string }> | null = null;
    rl.on("line", async (line) => {
      const next = await this.handleLine(line.trim(), awaitingChoice);
      awaitingChoice = next;
    });
    rl.on("close", () => { if (!this.stopped) process.exit(0); });
  }

  // Shared command handler — returns new awaitingChoice state.
  private async handleLine(
    trimmed: string,
    awaitingChoice: Array<{ brain: string; session: string }> | null,
  ): Promise<Array<{ brain: string; session: string }> | null> {
    if (!trimmed) return awaitingChoice;

    // Pending session-selection
    if (awaitingChoice) {
      const idx = parseInt(trimmed, 10) - 1;
      const choice = awaitingChoice[idx];
      if (choice) {
        this.print(`${C.dim}切换到 ${choice.brain} / ${choice.session}${C.reset}\n`);
        await this.switchTo(choice.brain, choice.session);
      } else {
        this.print(`${C.dim}无效选项${C.reset}\n`);
      }
      return null;
    }

    // /brains
    if (trimmed === "/brains") {
      const ids = await listBrainIds(this.rootDir);
      let out = `\n${C.bold}可用 brains:${C.reset}\n`;
      for (const id of ids) out += `${id === this.activeBrain ? `${C.green}●${C.reset} ` : "  "}${id}\n`;
      this.print(out + "\n");
      return null;
    }

    // /sessions [brainId]
    if (trimmed.startsWith("/sessions")) {
      const targetBrain = trimmed.split(/\s+/)[1] ?? this.activeBrain;
      const brainIds = await listBrainIds(this.rootDir);
      if (!brainIds.includes(targetBrain)) {
        this.print(`${C.dim}未知 brain: ${targetBrain}${C.reset}\n`);
        return null;
      }
      const sessions = await listSessionIds(this.rootDir, targetBrain);
      if (!sessions.length) {
        this.print(`${C.dim}${targetBrain} 没有 session${C.reset}\n`);
        return null;
      }
      const choices: Array<{ brain: string; session: string }> = [];
      let out = `\n${C.bold}${targetBrain} sessions:${C.reset}\n`;
      for (let i = 0; i < sessions.length; i++) {
        const sid = sessions[i];
        const cur = targetBrain === this.activeBrain && sid === this.activeSession;
        out += `  ${i + 1}.${cur ? `${C.green}●${C.reset}` : " "} ${sid}\n`;
        choices.push({ brain: targetBrain, session: sid });
      }
      out += `\n输入序号切换（Enter 取消）: `;
      this.print(out);
      return choices;
    }

    // Other slash commands → brain
    if (trimmed.startsWith("/")) {
      const cmd = parseCommand(trimmed);
      if (cmd && this.activeBrain) this.callbacks.onBrainCommand(this.activeBrain, cmd.toolName, cmd.args);
      return null;
    }

    // Plain text → user input to brain
    if (this.activeBrain) this.callbacks.onUserInput(this.activeBrain, trimmed);
    return null;
  }
}
