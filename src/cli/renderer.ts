/** @desc CLIRenderer — interactive terminal renderer that tails events.jsonl */

import * as readline from "node:readline";
import { watch, readFileSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { C, cursorToCol0, cursorToCol, cursorUp, cursorDown, clearLine, clearToEnd } from "./ansi.js";
import { type RendererEvent, formatEvent } from "./events.js";
import { listBrainIds, listSessionIds } from "./fs-helpers.js";
import { SelectOverlay } from "./select-overlay.js";
import { parseCommand } from "../core/command-parser.js";

// ─── Public types ───

export interface RendererCallbacks {
  onUserInput(brainId: string, text: string): void;
  onBrainCommand(brainId: string, toolName: string, args: Record<string, string>): void;
}

// ─── Internal types ───

interface MineclawJson {
  renderer?: { activeBrain?: string; activeSession?: string };
  [key: string]: unknown;
}

const PROMPT             = `${C.cyan}›${C.reset} `;
const PROMPT_VISIBLE_LEN = 2; // "› "
const SPINNER_FRAMES     = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// ─── CLIRenderer ───

export class CLIRenderer {
  private rootDir: string;
  private configPath: string;
  private callbacks: RendererCallbacks;

  // Active context
  private activeBrain  = "";
  private activeSession = "";

  // Tail state
  private tailOffset = 0;
  private fsWatcher: ReturnType<typeof watch> | null = null;
  private stopped = false;

  // TTY / raw mode
  private isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  private inputBuffer = "";
  private inputHistory: string[] = [];
  private historyIdx  = -1;

  // Overlay state
  private overlay: SelectOverlay | null = null;
  private overlayOnConfirm: ((idx: number) => Promise<void>) | null = null;
  /** Prints queued while overlay is open — flushed on close. */
  private pendingPrints: string[] = [];

  // Spinner / thinking state
  private isThinking    = false;
  private spinnerFrame  = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(rootDir: string, callbacks: RendererCallbacks) {
    this.rootDir    = rootDir;
    this.configPath = join(rootDir, "mineclaw.json");
    this.callbacks  = callbacks;
  }

  async start(): Promise<void> {
    await this.resolveActive();
    this.startStdin();
    await this.replayAndTail();
  }

  stop(): void {
    this.stopped = true;
    this.fsWatcher?.close();
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
    if (this.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
  }

  // ─── Footer (status bar + input line) ───
  //
  // The renderer always occupies 2 fixed lines at the bottom:
  //   line N-1: dim status bar  (brain / session info + optional spinner)
  //   line N:   prompt + input buffer
  //
  // print() clears those 2 lines, writes content, then redraws them.
  // redrawInputLine() only redraws line N (for typing / backspace).
  // redrawStatusBar() only redraws line N-1 (for spinner updates).

  private writeStatusBar(): void {
    const spinner  = this.isThinking
      ? ` ${C.yellow}${SPINNER_FRAMES[this.spinnerFrame]}${C.reset}`
      : "";
    const session  = this.activeSession ? `…${this.activeSession.slice(-14)}` : "—";
    const cols     = process.stdout.columns ?? 80;
    const base     = `brain: ${this.activeBrain || "—"}  session: ${session}`;
    process.stdout.write(`${C.dim}${base.slice(0, cols - 4)}${C.reset}${spinner}`);
  }

  private drawFooter(): void {
    if (!this.isTTY) return;
    this.writeStatusBar();
    process.stdout.write("\n");
    clearLine();
    cursorToCol0();
    process.stdout.write(PROMPT + this.inputBuffer);
  }

  /** Redraw only the status bar line without disturbing the input line. */
  private redrawStatusBar(): void {
    if (!this.isTTY || this.overlay) return;
    cursorToCol0();
    cursorUp(1);
    clearLine();
    this.writeStatusBar();
    cursorDown(1);
    cursorToCol(PROMPT_VISIBLE_LEN + this.inputBuffer.length);
  }

  private redrawInputLine(): void {
    if (!this.isTTY) return;
    clearLine();
    cursorToCol0();
    process.stdout.write(PROMPT + this.inputBuffer);
  }

  /** Clear the 2-line footer area (cursor lands at start of status bar line). */
  private clearFooter(): void {
    cursorToCol0();           // col 0 of input line
    cursorUp(1);              // up to status bar
    clearToEnd();             // clear status bar + input line
  }

  // ─── Thinking indicator ───

  private setThinking(v: boolean): void {
    if (v === this.isThinking) return;
    this.isThinking = v;
    if (v) {
      this.spinnerFrame = 0;
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.redrawStatusBar();
      }, 100);
    } else {
      if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
      this.redrawStatusBar();
    }
  }

  // ─── Output ───

  private print(text: string): void {
    if (!text) return;
    if (this.overlay) {
      // Buffer while overlay is open to avoid corrupting its rendering
      this.pendingPrints.push(text);
      return;
    }
    if (!this.isTTY) { process.stdout.write(text); return; }
    this.clearFooter();
    process.stdout.write(text);
    this.drawFooter();
  }

  private printEvent(ev: RendererEvent, isLive = false): void {
    // turn_start/turn_end only update the thinking spinner for live events
    if (ev.k === "turn_start") { if (isLive) this.setThinking(true);  return; }
    if (ev.k === "turn_end")   { if (isLive) this.setThinking(false); return; }
    const text = formatEvent(ev);
    if (text) this.print(text);
  }

  // ─── Overlay lifecycle ───

  private openOverlay(ov: SelectOverlay, onConfirm: (idx: number) => Promise<void>): void {
    this.overlay          = ov;
    this.overlayOnConfirm = onConfirm;
    this.inputBuffer = "";
    // Cursor is on the input line row; draw the status bar on the row above, then
    // redraw the blank input line so the box has a clean anchor.
    cursorToCol0();
    cursorUp(1);
    clearLine();
    this.writeStatusBar();
    cursorDown(1);
    cursorToCol0();
    clearLine();
    process.stdout.write(PROMPT);
    ov.show();
  }

  private closeOverlay(): void {
    if (!this.overlay) return;
    this.overlay.clear();
    this.overlay          = null;
    this.overlayOnConfirm = null;
    this.redrawInputLine();
    // Flush buffered prints
    const buffered = this.pendingPrints.splice(0);
    for (const text of buffered) this.print(text);
  }

  // ─── Config ───

  private readConfig(): MineclawJson {
    try { return JSON.parse(readFileSync(this.configPath, "utf-8")) as MineclawJson; }
    catch { return {}; }
  }

  private async writeConfig(r: { activeBrain?: string; activeSession?: string }): Promise<void> {
    const cfg = this.readConfig();
    await writeFile(this.configPath, JSON.stringify({ ...cfg, renderer: { ...cfg.renderer, ...r } }, null, 2));
  }

  // ─── Resolve active brain + session ───

  private async resolveActive(): Promise<void> {
    const cfg     = this.readConfig();
    let brain     = cfg.renderer?.activeBrain   ?? "";
    let session   = cfg.renderer?.activeSession ?? "";
    const brainIds = await listBrainIds(this.rootDir);

    if (!brain || !brainIds.includes(brain)) brain = brainIds[0] ?? "";
    if (brain) {
      const sessions = await listSessionIds(this.rootDir, brain);
      if (!session || !sessions.includes(session)) session = sessions[0] ?? "";
    }
    this.activeBrain   = brain;
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
      const raw   = await readFile(this.eventsPath(), "utf-8");
      const bytes = Buffer.byteLength(raw, "utf-8");
      if (bytes <= this.tailOffset) return;
      const slice = Buffer.from(raw, "utf-8").subarray(this.tailOffset).toString("utf-8");
      this.tailOffset = bytes;
      for (const line of slice.split("\n")) {
        if (!line.trim()) continue;
        try { this.printEvent(JSON.parse(line) as RendererEvent, true); } catch { /* skip */ }
      }
    } catch { /* file not ready */ }
  }

  // ─── Switch session ───

  private async switchTo(brainId: string, sessionId: string): Promise<void> {
    this.fsWatcher?.close();
    this.fsWatcher    = null;
    this.tailOffset   = 0;
    this.activeBrain  = brainId;
    this.activeSession = sessionId;
    // Stop any in-progress spinner — the previous session's turn is irrelevant now
    this.setThinking(false);
    await this.writeConfig({ activeBrain: brainId, activeSession: sessionId });
    // Clear screen, re-establish the 2-line footer anchor, then replay new session
    process.stdout.write("\x1b[2J\x1b[H");
    this.drawFooter();
    await this.replayAndTail();
  }

  // ─── stdin ───

  private startStdin(): void {
    if (this.isTTY) this.startRawMode();
    else            this.startLineMode();
  }

  private startRawMode(): void {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    this.drawFooter();   // draw status bar + prompt

    process.stdin.on("data", (chunk: string) => {
      let i = 0;
      while (i < chunk.length) {
        const code = chunk.charCodeAt(i);

        if (code === 27) {
          // Peek: ESC followed by '[' in the same chunk → CSI escape sequence
          if (i + 1 < chunk.length && chunk[i + 1] === "[") {
            let seq = "\x1b[";
            i += 2;
            // Accumulate parameter bytes, terminated by a letter or '~'
            while (i < chunk.length && !/[A-Za-z~]/.test(chunk[i])) {
              seq += chunk[i++];
            }
            if (i < chunk.length) seq += chunk[i++];
            this.handleEscapeSeq(seq);
          } else {
            // Standalone ESC — cancel any open overlay
            if (this.overlay) this.closeOverlay();
            i++;
          }
          continue;
        }

        this.handleRawChar(chunk[i]);
        i++;
      }
    });
    process.stdin.on("end", () => { if (!this.stopped) process.exit(0); });
  }

  /** Handle a fully-parsed CSI escape sequence (e.g. "\x1b[A" for up-arrow). */
  private handleEscapeSeq(seq: string): void {
    if (this.overlay) {
      if (seq === "\x1b[A") { this.overlay.moveUp();   return; }
      if (seq === "\x1b[B") { this.overlay.moveDown(); return; }
      return; // ignore other sequences while overlay is open
    }
    // History navigation
    if (seq === "\x1b[A") {
      this.historyIdx  = Math.min(this.historyIdx + 1, this.inputHistory.length - 1);
      this.inputBuffer = this.inputHistory[this.inputHistory.length - 1 - this.historyIdx] ?? "";
      this.redrawInputLine();
    } else if (seq === "\x1b[B") {
      this.historyIdx  = Math.max(this.historyIdx - 1, -1);
      this.inputBuffer = this.historyIdx < 0
        ? ""
        : (this.inputHistory[this.inputHistory.length - 1 - this.historyIdx] ?? "");
      this.redrawInputLine();
    }
  }

  private handleRawChar(ch: string): void {
    const code = ch.charCodeAt(0);

    // ── Overlay-active shortcuts (non-escape keys) ──
    if (this.overlay) {
      if (code === 13 || code === 10) { this.confirmOverlay(); return; }
      if (code === 3) { process.kill(process.pid, "SIGINT"); return; }
      return; // swallow all other keys while overlay is open
    }

    // ── Normal input ──
    if (code === 3)   { process.kill(process.pid, "SIGINT"); return; }
    if (code === 4)   { if (!this.inputBuffer) process.kill(process.pid, "SIGINT"); return; }
    if (code === 21)  { this.inputBuffer = ""; this.redrawInputLine(); return; } // Ctrl+U

    if (code === 127 || code === 8) { // Backspace
      if (this.inputBuffer.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        this.redrawInputLine();
      }
      return;
    }

    if (code === 13 || code === 10) { // Enter
      const text = this.inputBuffer.trim();
      this.inputBuffer = "";
      this.historyIdx  = -1;
      this.clearFooter();
      process.stdout.write("\n");
      if (text) {
        if (this.inputHistory[this.inputHistory.length - 1] !== text) {
          this.inputHistory.push(text);
        }
        this.handleLine(text).then(() => { if (!this.overlay) this.drawFooter(); });
      } else {
        this.drawFooter();
      }
      return;
    }

    if (code >= 32) { // Printable
      this.inputBuffer += ch;
      process.stdout.write(ch);  // echo inline
    }
  }

  // ─── Overlay confirm ───

  private async confirmOverlay(): Promise<void> {
    if (!this.overlay || !this.overlayOnConfirm) return;
    const idx      = this.overlay.selectedIndex;
    const handler  = this.overlayOnConfirm;
    this.closeOverlay();
    await handler(idx);
  }

  // ─── Overlay helpers ───

  private async showBrainsOverlay(): Promise<void> {
    const ids = await listBrainIds(this.rootDir);
    if (!ids.length) { this.print(`${C.dim}没有可用的 brain${C.reset}\n`); return; }
    const items = ids.map(id => ({
      label: id,
      hint:  id === this.activeBrain ? "(active)" : undefined,
    }));
    this.openOverlay(
      new SelectOverlay("brains", items, Math.max(0, ids.indexOf(this.activeBrain))),
      async (idx) => { await this.showSessionsOverlay(ids[idx]); },
    );
  }

  private async showSessionsOverlay(brainId?: string): Promise<void> {
    const targetBrain = brainId ?? this.activeBrain;
    if (!targetBrain) { this.print(`${C.dim}未指定 brain${C.reset}\n`); return; }
    const sessions = await listSessionIds(this.rootDir, targetBrain);
    if (!sessions.length) { this.print(`${C.dim}${targetBrain} 没有 session${C.reset}\n`); return; }

    const items = sessions.map(sid => ({
      label: sid,
      hint:  targetBrain === this.activeBrain && sid === this.activeSession ? "(active)" : undefined,
    }));
    this.openOverlay(
      new SelectOverlay(`${targetBrain} sessions`, items, Math.max(0, sessions.indexOf(this.activeSession))),
      async (idx) => {
        const sid = sessions[idx];
        if (sid) {
          this.print(`${C.dim}切换到 ${targetBrain} / ${sid}${C.reset}\n`);
          await this.switchTo(targetBrain, sid);
        }
      },
    );
  }

  // ─── Line mode (piped / non-TTY) ───

  private startLineMode(): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", line => this.handleLine(line.trim()));
    rl.on("close", () => { if (!this.stopped) process.exit(0); });
  }

  // ─── Command router ───

  private async handleLine(trimmed: string): Promise<void> {
    if (!trimmed) return;

    if (trimmed === "/brains")               { await this.showBrainsOverlay();   return; }
    if (trimmed.startsWith("/sessions"))     { await this.showSessionsOverlay(trimmed.split(/\s+/)[1]); return; }
    if (trimmed === "/clear")                { this.clearScreen(); return; }

    if (trimmed.startsWith("/")) {
      const cmd = parseCommand(trimmed);
      if (cmd && this.activeBrain) this.callbacks.onBrainCommand(this.activeBrain, cmd.toolName, cmd.args);
      return;
    }

    if (this.activeBrain) this.callbacks.onUserInput(this.activeBrain, trimmed);
  }

  private clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
    this.drawFooter();
  }
}
