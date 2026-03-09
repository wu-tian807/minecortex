/** @desc CLIRenderer — interactive terminal renderer that tails events.jsonl */

import * as readline from "node:readline";
import { watch, readFileSync, existsSync } from "node:fs";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

import { C, cursorToCol0, cursorToCol, cursorUp, cursorDown, clearLine, clearToEnd } from "./ansi.js";
import { type RendererEvent, type InputSegment, formatEvent, parseRendererEvent } from "./events.js";
import { listBrainIds, listSessionIds } from "./fs-helpers.js";
import { SelectOverlay } from "./select-overlay.js";
import { StatusBar } from "./status-bar.js";
import { parseCommand } from "../core/command-parser.js";
import { PathManager } from "../fs/path-manager.js";
import { SessionManager } from "../session/session-manager.js";

// ─── Public types ───

export interface RendererCallbacks {
  onUserInput(brainId: string, text: string): void;
  onBrainCommand(brainId: string, toolName: string, args: Record<string, string>): void;
  /** Watch context usage ratio (0–1) for the given brain. Returns an unsubscribe fn. */
  watchContextUsage(brainId: string, cb: (ratio: number | null) => void): () => void;
}

// ─── Internal types ───

interface MineclawJson {
  renderer?: { activeBrain?: string };
  [key: string]: unknown;
}

const PROMPT             = `${C.cyan}›${C.reset} `;
const PROMPT_VISIBLE_LEN = 2; // "› "
const THINKING_PREVIEW_MAX = 120;


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
  private sessionWatcher: ReturnType<typeof watch> | null = null;
  private stopped = false;

  // TTY / raw mode
  private isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  /**
   * Input is stored as an ordered list of segments so that multiple paste
   * batches remain independent atomic units interleaved with typed text.
   * Each "paste" segment is deleted as a whole on a single Backspace.
   */
  private segments: InputSegment[] = [];
  private inputHistory: string[] = [];
  private historyIdx  = -1;

  private get inputContent(): string {
    return this.segments.map((s) => s.content).join("");
  }
  private inputAppendChar(ch: string): void {
    const last = this.segments.at(-1);
    if (last?.type === "text") { last.content += ch; }
    else                        { this.segments.push({ type: "text", content: ch }); }
  }
  private inputAppendPaste(text: string): void {
    this.segments.push({ type: "paste", content: text });
  }
  private inputBackspace(): void {
    const last = this.segments.at(-1);
    if (!last) return;
    if (last.type === "paste") {
      this.segments.pop();                                   // whole block deleted at once
    } else if (last.content.length > 1) {
      last.content = last.content.slice(0, -1);
    } else {
      this.segments.pop();
    }
  }
  private inputClear(): void { this.segments = []; }
  private inputSet(text: string): void {
    this.segments = text ? [{ type: "text", content: text }] : [];
  }

  // Overlay state
  private overlay: SelectOverlay | null = null;
  private overlayOnConfirm: ((idx: number) => Promise<void>) | null = null;
  /** Prints queued while overlay is open — flushed on close. */
  private pendingPrints: string[] = [];

  // Status bar component (brain/session label + context ring + spinner)
  private statusBar = new StatusBar();
  private thinkingPreview = "";
  private streamingActive = false;
  private streamingNeedsNewline = false;
  private _redrawPending = false;

  constructor(rootDir: string, callbacks: RendererCallbacks) {
    this.rootDir    = rootDir;
    this.configPath = join(rootDir, "minecortex.json");
    this.callbacks  = callbacks;
  }

  async start(): Promise<void> {
    const needsSelection = await this.resolveActive();
    this.startStdin(); // sets raw mode + draws footer
    if (needsSelection) {
      await this.showBrainsOverlay(); // non-blocking; key events drive the rest
    } else {
      this.subscribeContext(this.activeBrain);
      await this.replayAndTail();
    }
  }

  stop(): void {
    this.stopped = true;
    this.fsWatcher?.close();
    this.sessionWatcher?.close();
    this.statusBar.stop();
    if (this.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
  }

  // ─── Footer (status bar + input line) ───
  //
  // The renderer always occupies 3 fixed lines at the bottom:
  //   line N-2: dim thinking preview (streaming only)
  //   line N-1: dim status bar  (brain / session info + optional spinner)
  //   line N:   prompt + input buffer
  //
  // print() clears those 3 lines, writes content, then redraws them.
  // redrawInputLine() only redraws line N (for typing / backspace).
  // redrawStatusBar() only redraws line N-1 (for spinner updates).

  private renderThinkingPreview(): string {
    if (!this.thinkingPreview) return "";
    const normalized = this.thinkingPreview.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    // Sliding window: show only the tail so the line doesn't grow unboundedly
    const clipped = normalized.length > THINKING_PREVIEW_MAX
      ? `...${normalized.slice(-(THINKING_PREVIEW_MAX - 3))}`
      : normalized;
    return `${C.dim}💭 ${clipped}${C.reset}`;
  }

  private drawFooter(): void {
    if (!this.isTTY) return;
    clearLine(); cursorToCol0();
    process.stdout.write(this.renderThinkingPreview() + "\n");
    process.stdout.write(this.statusBar.render() + "\n");
    clearLine(); cursorToCol0();
    process.stdout.write(PROMPT + this.inputContent);
  }

  /** Redraw a single footer row (rowsUp above the input line) without disturbing the rest. */
  private redrawFooterRow(rowsUp: number, content: string): void {
    if (!this.isTTY || this.overlay || this.streamingActive) return;
    cursorToCol0(); cursorUp(rowsUp); clearLine();
    process.stdout.write(content);
    cursorDown(rowsUp); cursorToCol(PROMPT_VISIBLE_LEN + this.inputContent.length);
  }

  private redrawStatusBar(): void    { this.redrawFooterRow(1, this.statusBar.render()); }
  private redrawThinkingPreview(): void { this.redrawFooterRow(2, this.renderThinkingPreview()); }

  /**
   * Batch-schedule a footer redraw via microtask.
   * Multiple calls within the same event-loop turn collapse into one repaint,
   * and the repaint is always deferred until the current task finishes —
   * so the cursor is guaranteed to be on the input line when it runs.
   */
  private scheduleRedraw(): void {
    if (!this.isTTY || this._redrawPending || this.streamingActive) return;
    this._redrawPending = true;
    queueMicrotask(() => {
      this._redrawPending = false;
      if (!this.streamingActive && !this.overlay) {
        this.clearFooter();
        this.drawFooter();
      }
    });
  }

  private redrawInputLine(): void {
    if (!this.isTTY) return;
    clearLine();
    cursorToCol0();
    let display = "";
    for (const seg of this.segments) {
      if (seg.type === "paste") {
        const lines = seg.content.split("\n").length;
        display += `\x1b[44;97m[已粘贴 ${lines} 行]\x1b[0m`; // blue bg, white text
      } else {
        display += seg.content;
      }
    }
    process.stdout.write(PROMPT + display);
  }

  /** Clear the 3-line footer area (cursor lands at start of thinking line). */
  private clearFooter(): void {
    cursorToCol0();           // col 0 of input line
    cursorUp(2);              // up to thinking line
    clearToEnd();             // clear thinking + status bar + input line
  }

  // ─── Context usage subscription ───

  private subscribeContext(brainId: string): void {
    this.statusBar.contextRing.subscribe(brainId, this.callbacks.watchContextUsage, () => {
      this.scheduleRedraw();
    });
  }

  // ─── Thinking indicator ───

  private setThinking(v: boolean): void {
    this.statusBar.setThinking(v, () => this.scheduleRedraw());
    this.scheduleRedraw();
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

  private appendTextChunk(text: string): void {
    if (!text || !this.isTTY || this.overlay) return;
    if (!this.streamingActive) {
      this.streamingActive = true;
      this.clearFooter();
      process.stdout.write(`${C.cyan}[${this.activeBrain}]${C.reset} `);
    }
    this.streamingNeedsNewline = !text.endsWith("\n");
    process.stdout.write(text);
  }

  private appendThinkingChunk(text: string): void {
    if (!text) return;
    this.thinkingPreview += text;
    this.redrawThinkingPreview();
  }

  private resetStreamingState(): void {
    this.thinkingPreview = "";
    this.streamingActive = false;
    this.streamingNeedsNewline = false;
  }

  /** Finalize live streaming state and restore the footer.
   *  Returns true if text was already streamed inline (so the caller can skip reprinting). */
  private finalizeLiveAssistant(): boolean {
    const hadStreaming = this.streamingActive;
    if (this.isTTY) {
      if (hadStreaming) {
        if (this.streamingNeedsNewline) process.stdout.write("\n");
        this.drawFooter();
      } else if (this.thinkingPreview) {
        this.clearFooter();
        this.drawFooter();
      }
    }
    this.resetStreamingState();
    return hadStreaming;
  }

  private printEvent(ev: RendererEvent, isLive = false): void {
    // turn_start/turn_end only update the thinking spinner for live events
    if (ev.k === "turn_start") {
      if (isLive) {
        this.resetStreamingState();
        this.redrawThinkingPreview();
        this.setThinking(true);
      }
      return;
    }
    if (ev.k === "turn_end") {
      if (isLive) {
        this.finalizeLiveAssistant(); // cleans up any leftover streaming / thinking state
        this.setThinking(false);
      }
      return;
    }
    if (ev.k === "assistant_chunk") {
      if (!isLive) return;
      if (ev.kind === "text") this.appendTextChunk(ev.text);
      if (ev.kind === "thinking") this.appendThinkingChunk(ev.text);
      return;
    }
    if (ev.k === "assistant" && isLive) {
      const alreadyStreamed = this.finalizeLiveAssistant();
      const printText    = !alreadyStreamed && Boolean(ev.text?.trim());
      const printThinking = Boolean(ev.thinking?.trim());
      if (printText || printThinking) {
        const out = formatEvent({ ...ev, text: printText ? ev.text : undefined, thinking: printThinking ? ev.thinking : undefined });
        if (out) this.print(out);
      }
      return;
    }
    const text = formatEvent(ev);
    if (text) this.print(text);
  }

  // ─── Overlay lifecycle ───

  private openOverlay(ov: SelectOverlay, onConfirm: (idx: number) => Promise<void>): void {
    this.overlay          = ov;
    this.overlayOnConfirm = onConfirm;
    this.inputClear();
    // Cursor is on the input line row; redraw the footer so the overlay has a clean anchor.
    this.clearFooter();
    this.drawFooter();
    ov.show();
  }

  private closeOverlay(): void {
    if (!this.overlay) return;
    this.overlay.clear();
    this.overlay          = null;
    this.overlayOnConfirm = null;
    this.drawFooter();
    // Flush buffered prints
    const buffered = this.pendingPrints.splice(0);
    for (const text of buffered) this.print(text);
  }

  // ─── Config ───

  private readConfig(): MineclawJson {
    try { return JSON.parse(readFileSync(this.configPath, "utf-8")) as MineclawJson; }
    catch { return {}; }
  }

  private async writeConfig(activeBrain: string): Promise<void> {
    const cfg = this.readConfig();
    await writeFile(this.configPath, JSON.stringify({ ...cfg, renderer: { activeBrain } }, null, 2));
  }

  /** Write currentSessionId to a brain's session.json (single source of truth for active session). */
  private async writeSessionJson(brainId: string, sessionId: string): Promise<void> {
    const sessionJsonPath = join(this.rootDir, "brains", brainId, "session.json");
    try {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(readFileSync(sessionJsonPath, "utf-8")); } catch { /* fresh */ }
      data.currentSessionId = sessionId;
      await writeFile(sessionJsonPath, JSON.stringify(data, null, 2));
    } catch { /* ignore */ }
  }

  /** Read currentSessionId from a brain's session.json. */
  private readSessionJson(brainId: string): string {
    try {
      const sessionJsonPath = join(this.rootDir, "brains", brainId, "session.json");
      const data = JSON.parse(readFileSync(sessionJsonPath, "utf-8")) as { currentSessionId?: string };
      return data.currentSessionId ?? "";
    } catch { return ""; }
  }

  // ─── Resolve active brain + session ───

  private async resolveActive(): Promise<boolean> {
    const cfg      = this.readConfig();
    const brain    = cfg.renderer?.activeBrain ?? "";
    const brainIds = await listBrainIds(this.rootDir);

    // No saved brain, or it no longer exists on disk — show the selection overlay
    if (!brain || !brainIds.includes(brain)) {
      this.activeBrain   = "";
      this.activeSession = "";
      this.statusBar.setContext("", "");
      return true;
    }

    // session.json is the single source of truth for which session is current
    const session = this.readSessionJson(brain);
    const sessions = await listSessionIds(this.rootDir, brain);
    this.activeBrain   = brain;
    this.activeSession = (session && sessions.includes(session)) ? session : (sessions[0] ?? "");
    this.statusBar.setContext(this.activeBrain, this.activeSession);
    return false;
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
        const ev = parseRendererEvent(line);
        if (ev) this.printEvent(ev);
      }
      this.tailOffset = Buffer.byteLength(raw, "utf-8");
    } else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "", "utf-8");
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

    this.watchSessionJson();
  }

  private watchSessionJson(): void {
    this.sessionWatcher?.close();
    if (!this.activeBrain) return;
    const sessionJsonPath = join(this.rootDir, "brains", this.activeBrain, "session.json");
    if (!existsSync(sessionJsonPath)) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    this.sessionWatcher = watch(sessionJsonPath, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => this.onSessionJsonChange(), 120);
    });
  }

  private onSessionJsonChange(): void {
    if (!this.activeBrain) return;
    try {
      const sessionJsonPath = join(this.rootDir, "brains", this.activeBrain, "session.json");
      const data = JSON.parse(readFileSync(sessionJsonPath, "utf-8")) as { currentSessionId?: string };
      const newSid = data.currentSessionId;
      if (!newSid || newSid === this.activeSession) return;
      this.switchTo(this.activeBrain, newSid).catch(() => {});
    } catch { /* ignore */ }
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
        const ev = parseRendererEvent(line);
        // user_input is printed immediately on handleLine; skip here to avoid duplicates
        if (ev && ev.k !== "user_input") this.printEvent(ev, true);
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
    this.statusBar.setContext(brainId, sessionId);
    this.resetStreamingState();
    this.setThinking(false);
    this.subscribeContext(brainId);
    // session.json is the truth — update it so the brain uses this session going forward
    await this.writeSessionJson(brainId, sessionId);
    // activeBrain is the only thing persisted in minecortex.json
    await this.writeConfig(brainId);
    // Clear screen, re-establish the footer anchor, then replay new session
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
      // ── Paste detection ──────────────────────────────────────────────────────
      // A paste arrives as one large data chunk containing newlines.
      // A real Enter key press is just "\r" or "\n" (length 1).
      // An escape sequence starts with \x1b — not a paste.
      const hasNL = chunk.includes("\n") || chunk.includes("\r");
      if (chunk.length > 1 && hasNL && chunk.charCodeAt(0) !== 27) {
        const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
        this.inputAppendPaste(normalized);
        this.redrawInputLine();
        return;
      }
      // ─────────────────────────────────────────────────────────────────────────

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
      this.historyIdx = Math.min(this.historyIdx + 1, this.inputHistory.length - 1);
      this.inputSet(this.inputHistory[this.inputHistory.length - 1 - this.historyIdx] ?? "");
      this.redrawInputLine();
    } else if (seq === "\x1b[B") {
      this.historyIdx = Math.max(this.historyIdx - 1, -1);
      this.inputSet(this.historyIdx < 0
        ? ""
        : (this.inputHistory[this.inputHistory.length - 1 - this.historyIdx] ?? ""));
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
    if (code === 4)   { if (!this.inputContent) process.kill(process.pid, "SIGINT"); return; }
    if (code === 21)  { this.inputClear(); this.redrawInputLine(); return; } // Ctrl+U

    if (code === 127 || code === 8) { // Backspace
      this.inputBackspace();
      this.redrawInputLine();
      return;
    }

    if (code === 13 || code === 10) { // Enter
      const text     = this.inputContent.trim();
      const segments = this.segments.map(s => ({ ...s })); // snapshot before clear
      this.inputClear();
      this.historyIdx = -1;
      this.clearFooter();
      if (text) {
        if (this.inputHistory[this.inputHistory.length - 1] !== text) {
          this.inputHistory.push(text);
        }
        this.handleLine(text, segments).then(() => { if (!this.overlay) this.drawFooter(); });
      } else {
        this.drawFooter();
      }
      return;
    }

    if (code >= 32) { // Printable
      this.inputAppendChar(ch);
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

    const items = sessions.map(sid => ({
      label: sid,
      hint:  targetBrain === this.activeBrain && sid === this.activeSession ? "(active)" : undefined,
    }));
    items.push({ label: "+ New Session", hint: undefined });

    const activeIdx = sessions.indexOf(this.activeSession);
    this.openOverlay(
      new SelectOverlay(`${targetBrain} sessions`, items, Math.max(0, activeIdx)),
      async (idx) => {
        if (idx === sessions.length) {
          const pm = new PathManager(this.rootDir);
          const sm = new SessionManager(targetBrain, pm);
          const newSid = await sm.createSession();
          this.print(`${C.dim}新建 session: ${targetBrain} / ${newSid}${C.reset}\n`);
          await this.switchTo(targetBrain, newSid);
        } else {
          const sid = sessions[idx];
          if (sid) {
            this.print(`${C.dim}切换到 ${targetBrain} / ${sid}${C.reset}\n`);
            await this.switchTo(targetBrain, sid);
          }
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

  private async handleLine(trimmed: string, segments: InputSegment[] = []): Promise<void> {
    if (!trimmed) return;

    if (trimmed === "/brains")               { await this.showBrainsOverlay();   return; }
    if (trimmed.startsWith("/sessions"))     { await this.showSessionsOverlay(trimmed.split(/\s+/)[1]); return; }
    if (trimmed === "/clear")                { this.clearScreen(); return; }

    if (trimmed.startsWith("/")) {
      const cmd = parseCommand(trimmed);
      if (cmd && this.activeBrain) {
        this.callbacks.onBrainCommand(this.activeBrain, cmd.toolName, cmd.args);
        // Write to events.jsonl so replay can show the command (same pattern as user_input).
        const ev: RendererEvent = { k: "command", brain: this.activeBrain, toolName: cmd.toolName, ts: Date.now() };
        const rendered = formatEvent(ev);
        if (rendered) process.stdout.write(rendered);
        const evPath = this.eventsPath();
        appendFile(evPath, JSON.stringify(ev) + "\n", "utf-8").catch(() => {});
        this.tailOffset += Buffer.byteLength(JSON.stringify(ev) + "\n", "utf-8");
      } else if (!this.activeBrain) {
        process.stdout.write(`${C.dim}⚠ 没有激活的 brain，命令未发送${C.reset}\n`);
      } else {
        process.stdout.write(`${C.dim}⚠ 无法解析命令: ${trimmed}${C.reset}\n`);
      }
      return;
    }

    if (this.activeBrain) {
      // Render immediately (with paste blocks in blue) — no need to wait for events.jsonl round-trip.
      // Use process.stdout.write directly: the Enter handler already called clearFooter() and will
      // call drawFooter() in the .then() — using this.print() would cause a double footer draw.
      const ev: RendererEvent = { k: "user_input", text: trimmed, segments, ts: Date.now() };
      const rendered = formatEvent(ev);
      if (rendered) process.stdout.write(rendered);

      // Write directly to events.jsonl so replay can restore the blue paste blocks.
      // The recorder skips events.jsonl for CLI user_input (source="user") to avoid duplicates.
      const evPath = this.eventsPath();
      appendFile(evPath, JSON.stringify(ev) + "\n", "utf-8").catch(() => {});
      this.tailOffset += Buffer.byteLength(JSON.stringify(ev) + "\n", "utf-8");

      this.callbacks.onUserInput(this.activeBrain, trimmed);
    }
  }

  private clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
    this.drawFooter();
  }
}
