/** @desc CLIRenderer — interactive terminal renderer that tails events.jsonl */

import * as readline from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

import {
  C,
  clearScreen,
  calcDisplayWidth,
} from "./ansi.js";
import { FooterRenderer, type FooterCursorPos } from "./footer-renderer.js";
import { type RendererEvent, type InputSegment, formatEvent, parseRendererEvent } from "./events.js";
import { renderMarkdown } from "./markdown.js";
import { SelectOverlay } from "./select-overlay.js";
import { StatusBar } from "./status-bar.js";
import { parseCommand } from "../core/command-parser.js";
import { getPathManager } from "../fs/index.js";
import { InputBuffer } from "./input-buffer.js";
import { RendererConfig } from "./renderer-config.js";
import { EventTailer } from "./event-tailer.js";
import { showBrainsOverlay, showSessionsOverlay, type OverlayHost } from "./overlay-helpers.js";

// ─── Public types ───

export interface RendererCallbacks {
  onUserInput(brainId: string, text: string): void;
  onBrainCommand(brainId: string, toolName: string, args: Record<string, string>): void;
  /** Watch context usage ratio (0–1) for the given brain. Returns an unsubscribe fn. */
  watchContextUsage(brainId: string, cb: (ratio: number | null) => void): () => void;
  /** Subscribe to the shared EventBus for in-process live streaming events. Returns unsubscribe fn. */
  observeEvents(handler: (event: { source: string; type: string; payload: unknown; to?: string }) => void): () => void;
}

// ─── Internal types ───

/** All mutable state related to a streaming turn, reset at turn boundaries. */
interface StreamingState {
  active:   boolean;
  thinking: string;
}

const PROMPT      = `${C.cyan}›${C.reset} `;
/** Continuation-line indent — same visual width as PROMPT (2 columns). */
const PROMPT_CONT = "  ";

function makeStreamingState(): StreamingState {
  return { active: false, thinking: "" };
}

// ─── CLIRenderer ───

export class CLIRenderer implements OverlayHost {
  private callbacks: RendererCallbacks;

  // Active context
  activeBrain   = "";
  activeSession = "";

  // TTY / raw mode
  private isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  private input   = new InputBuffer();
  private config:  RendererConfig;
  private tailer:  EventTailer;
  private stopped  = false;

  // Overlay state
  private overlay:          SelectOverlay | null = null;
  private overlayOnConfirm: ((idx: number) => Promise<void>) | null = null;
  /** Prints queued while overlay is open — flushed on close. */
  private pendingPrints: string[] = [];

  // Status bar component (brain/session label + context ring + spinner)
  private statusBar = new StatusBar();
  /** Unsubscribe function returned by observeEvents — kept for cleanup. */
  private liveUnsub: (() => void) | null = null;

  /** All streaming-turn state grouped in one place. */
  private streaming = makeStreamingState();

  private _redrawPending = false;
  /** Owns the terminal's last 3 rows (thinking preview + status bar + input line). */
  private footer: FooterRenderer;

  constructor(rootDir: string, callbacks: RendererCallbacks) {
    this.callbacks = callbacks;
    this.footer    = new FooterRenderer(this.isTTY);
    this.config    = new RendererConfig(join(rootDir, "minecortex.json"));
    this.tailer    = new EventTailer(
      () => this.eventsPath(),
      () => this.activeBrain,
      () => this.activeSession,
      (ev, isLive, nextByteOffset) => this.printEvent(ev, isLive, nextByteOffset),
      (brainId, sessionId) => this.switchTo(brainId, sessionId).catch(() => {}),
    );
  }

  async start(): Promise<void> {
    const ctx = await this.config.resolveActive();
    this.activeBrain   = ctx.brain;
    this.activeSession = ctx.session;
    this.statusBar.setContext(ctx.brain, ctx.session);
    this.footer.setupScrollRegion();
    // Redraw footer on terminal resize so absolute rows stay correct.
    process.stdout.on("resize", () => {
      const line = this.buildInputLine();
      const count = this.countInputRows(line);
      this.lastInputLineCount = count;
      this.footer.setupScrollRegion(count);
      this.drawFooter();
    });
    this.startStdin();
    if (ctx.needsSelection) {
      await showBrainsOverlay(this);
    } else {
      this.subscribeContext(this.activeBrain);
      await this.replayAndTail();
    }
  }

  stop(): void {
    this.stopped = true;
    this.tailer.stop();
    this.statusBar.stop();
    this.unsubscribeLiveBus();
    if (this.isTTY) {
      this.footer.resetScrollRegion();
      // Reset keyboard protocols back to defaults.
      try { process.stdout.write("\x1b[=0u"); }  catch { /* ignore */ } // kitty
      try { process.stdout.write("\x1b[>4;0m"); } catch { /* ignore */ } // modifyOtherKeys
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
  }

  private subscribeLiveBus(): void {
    this.unsubscribeLiveBus();
    this.liveUnsub = this.callbacks.observeEvents((e) => {
      if (e.type !== "live_turn_start" && e.type !== "live_chunk") return;
      const p = e.payload as Record<string, unknown>;
      const brain = String(p.brain ?? e.source);
      if (brain !== this.activeBrain) return;

      if (e.type === "live_turn_start") {
        this.streaming = makeStreamingState();
        this.setThinking(true);
      } else if (e.type === "live_chunk") {
        const kind = String(p.kind ?? "");
        const text = String(p.text ?? "");
        if (kind === "text")     this.appendTextChunk(text);
        if (kind === "thinking") this.appendThinkingChunk(text);
      }
    });
  }

  private unsubscribeLiveBus(): void {
    if (this.liveUnsub) {
      this.liveUnsub();
      this.liveUnsub = null;
    }
  }

  // ─── Footer (status bar + input line) ───
  //
  // FooterRenderer owns the last 3 terminal rows (absolute positions):
  //   row N-2 : thinking preview
  //   row N-1 : status bar  (brain / session info + spinner)
  //   row N   : prompt + input buffer
  //
  // A scroll region (rows 1..N-3) keeps content out of the footer area.
  // All FooterRenderer methods use \x1b[s / \x1b[u to save and restore the
  // cursor, so they are safe to call at any time — including during streaming.
  //
  // drawFooter()      — full footer redraw (all 3 rows).
  // redrawInputLine() — input row only (each keypress).
  // scheduleRedraw()  — microtask-batched redraw:
  //                     • streaming active → updateStatusBar only (spinner)
  //                     • otherwise        → full footer redraw

  private renderThinkingPreview(): string {
    if (!this.streaming.thinking) return "";
    const normalized = this.streaming.thinking.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    const maxChars = Math.max(20, (process.stdout.columns ?? 80) - 6);
    const clipped = normalized.length > maxChars
      ? `...${normalized.slice(-(maxChars - 3))}`
      : normalized;
    return `${C.dim}💭 ${clipped}${C.reset}`;
  }

  /** Build the input display string for FooterContent.inputLine(). Multiline inputs
   *  are joined with "\n"; the footer renderer splits them back into rows. */
  private buildInputLine(): string {
    const lines = this.input.buildDisplayLines();
    return lines.map((l, i) => (i === 0 ? PROMPT : PROMPT_CONT) + l).join("\n");
  }

  private footerContent() {
    return {
      thinkingPreview: () => this.renderThinkingPreview(),
      statusBarLine:   () => this.statusBar.render(),
      inputLine:       () => this.buildInputLine(),
    };
  }

  private inputCursorPos(): FooterCursorPos {
    const { lineIdx, colWidth } = this.input.cursorDisplayPos();
    const cols        = Math.max(1, process.stdout.columns ?? 80);
    // PROMPT and PROMPT_CONT both have display width 2.
    const prefixWidth = calcDisplayWidth(PROMPT);

    // Convert logical (lineIdx, colWidth) → visual (row, col) by accounting for
    // terminal-width auto-wrapping of all lines before and including the cursor line.
    const displayLines = this.input.buildDisplayLines();

    // Count visual rows contributed by each logical line before the cursor.
    let visualRow = 0;
    for (let i = 0; i < lineIdx; i++) {
      const w = prefixWidth + calcDisplayWidth(displayLines[i] ?? "");
      visualRow += Math.max(1, Math.ceil(w / cols));
    }

    // Add visual-row offset within the cursor's own logical line.
    const curW = prefixWidth + colWidth;
    visualRow += Math.floor(curW / cols);
    const visualCol = (curW % cols) + 1; // 1-indexed terminal column

    return { lineIdx: visualRow, col: visualCol };
  }

  /** Tracks the input line count so we know when to resize the scroll region. */
  private lastInputLineCount = 1;

  private drawFooter(): void {
    // During streaming or while an overlay is open, restore cursor to its saved
    // position so ongoing output / overlay rendering is undisturbed.
    // Otherwise, leave the cursor inside the input area so the user can type.
    const cursor = (!this.streaming.active && !this.overlay)
      ? this.inputCursorPos()
      : undefined;
    this.footer.draw(this.footerContent(), cursor);
  }

  private refreshFooter(): void {
    this.drawFooter();
  }

  /**
   * Batch-schedule a footer redraw via microtask.
   * During streaming: only update the status bar row (spinner) — saves cursor,
   * updates one row, restores cursor — so ongoing streaming is undisturbed.
   */
  private scheduleRedraw(): void {
    if (!this.isTTY || this._redrawPending) return;
    this._redrawPending = true;
    queueMicrotask(() => {
      this._redrawPending = false;
      if (this.overlay) return;
      if (this.streaming.active) {
        // Spinner-only update: save cursor → update row N-1 → restore cursor
        this.footer.updateStatusBar(this.statusBar.render());
      } else {
        this.refreshFooter();
      }
    });
  }

  /** Count how many terminal rows the input line occupies, accounting for terminal-width wrapping. */
  private countInputRows(line: string): number {
    const cols = Math.max(1, process.stdout.columns ?? 80);
    return line.split("\n").reduce((sum, part) => {
      return sum + Math.max(1, Math.ceil(calcDisplayWidth(part) / cols));
    }, 0);
  }

  /**
   * Redraw the input area and position the terminal cursor correctly.
   * When the number of input lines changes the scroll region is resized and a
   * full footer redraw is triggered; otherwise only the input rows are updated.
   */
  private redrawInput(): void {
    const line     = this.buildInputLine();
    const newCount = this.countInputRows(line);
    if (newCount !== this.lastInputLineCount) {
      this.lastInputLineCount = newCount;
      this.footer.setupScrollRegion(newCount);
      this.drawFooter();
      return;
    }
    this.footer.updateInputLine(line, this.inputCursorPos());
  }

  /** Erase footer rows (used before clearScreen so they don't flicker). */
  private clearFooter(): void {
    this.footer.clear();
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

  print(text: string): void {
    if (!text) return;
    if (this.overlay) { this.pendingPrints.push(text); return; }
    if (!this.isTTY) { process.stdout.write(text); return; }
    if (this.replaying) { process.stdout.write(text); return; }
    // Write at the bottom of the scroll region; content scrolls up within rows 1..N-3.
    // Footer rows (N-2, N-1, N) are protected by the scroll region and stay visible.
    process.stdout.write(`\x1b[${this.footer.contentBottom()};1H`);
    process.stdout.write(text);
    this.drawFooter();
  }

  private appendTextChunk(text: string): void {
    if (!text || !this.isTTY || this.overlay) return;
    if (!this.streaming.active) {
      this.streaming.active = true;
      // Move to the bottom of the scroll region (content area) and start a new line.
      // The scroll region keeps the footer rows visible throughout streaming.
      process.stdout.write(`\x1b[${this.footer.contentBottom()};1H`);
      process.stdout.write(`\n${C.cyan}[${this.activeBrain}]${C.reset} `);
    }
    process.stdout.write(text);
  }

  private appendThinkingChunk(text: string): void {
    if (!text) return;
    this.streaming.thinking += text;
    this.scheduleRedraw();
  }

  /** True while replayFromFile is running — print() skips footer redraws. */
  private replaying = false;

  /**
   * Clear screen and replay events from events.jsonl up to (and including) `untilOffset`.
   * If `untilOffset` is omitted, replays the entire file.
   *
   * During replay the scroll region is temporarily reset to full-screen so content
   * fills naturally from the top. After replay the scroll region is re-established and
   * the footer is redrawn at its absolute rows.
   *
   * Setting tailer.offset = untilOffset signals EventTailer.readNewLines to jump forward,
   * so events after the replayed range are processed exactly once by the live batch.
   */
  private replayFromFile(untilOffset?: number): void {
    const path = this.eventsPath();
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf-8");
    const buf = Buffer.from(raw, "utf-8");
    const stopAt = untilOffset !== undefined ? Math.min(untilOffset, buf.length) : buf.length;

    // Reset scroll region to full screen so replay content fills from the top.
    this.footer.resetScrollRegion();
    clearScreen();

    this.replaying = true;
    let pos = 0;
    while (pos < stopAt) {
      let lineEnd = pos;
      while (lineEnd < stopAt && buf[lineEnd] !== 0x0A) lineEnd++;
      const line = buf.subarray(pos, lineEnd).toString("utf-8").trim();
      pos = lineEnd < buf.length ? lineEnd + 1 : buf.length;
      if (pos > stopAt) pos = stopAt;
      const ev = parseRendererEvent(line);
      if (ev) this.printEvent(ev); // isLive=false → assistant renders as markdown
    }
    this.replaying = false;

    this.tailer.offset = stopAt; // signal readNewLines to resume from here

    // Re-establish scroll region and redraw footer.
    this.footer.setupScrollRegion();
    this.drawFooter();
  }

  /**
   * Replace streamed raw text with a full clearScreen + replay, then restore the footer.
   * `replayUntil` is the byte offset just after the triggering assistant event: replay
   * stops there so that events after it (tool_call, tool_result, …) are NOT double-printed
   * — the live readNewLines batch continues processing them normally.
   * Returns true if text was streamed this turn (caller should skip reprinting).
   */
  private finalizeLiveAssistant(replayUntil?: number): boolean {
    const { active: hadStreaming, thinking: hadThinkingText } = this.streaming;
    this.streaming = makeStreamingState();

    if (!this.isTTY) return hadStreaming;

    if (hadStreaming) {
      // Do NOT setThinking(false) here — the turn may continue with more tool calls.
      // Spinner stays on until turn_end fires.
      this.replayFromFile(replayUntil);
    } else if (hadThinkingText) {
      this.refreshFooter();
    }

    return hadStreaming;
  }

  private printEvent(ev: RendererEvent, isLive = false, replayUntil?: number): void {
    if (ev.k === "turn_start") {
      if (!isLive) this.streaming = makeStreamingState();
      return;
    }
    if (ev.k === "turn_end") {
      if (isLive) {
        if (this.streaming.active || this.streaming.thinking) {
          this.streaming = makeStreamingState();
          this.refreshFooter();
        }
        this.setThinking(false);
      }
      return;
    }
    if (ev.k === "assistant_chunk") {
      if (!isLive) return;
      if (ev.kind === "text")     this.appendTextChunk(ev.text);
      if (ev.kind === "thinking") this.appendThinkingChunk(ev.text);
      return;
    }
    if (ev.k === "assistant" && isLive) {
      const hadStreaming = this.streaming.active;
      this.finalizeLiveAssistant(replayUntil);
      if (!hadStreaming) {
        const out = formatEvent(ev);
        if (out) this.print(out);
      }
      return;
    }
    const text = formatEvent(ev);
    if (text) this.print(text);
  }

  // ─── Overlay lifecycle ───

  openOverlay(ov: SelectOverlay, onConfirm: (idx: number) => Promise<void>): void {
    this.overlay          = ov;
    this.overlayOnConfirm = onConfirm;
    this.input.clear();
    this.refreshFooter();
    ov.show();
  }

  private closeOverlay(): void {
    if (!this.overlay) return;
    this.overlay.clear();
    this.overlay          = null;
    this.overlayOnConfirm = null;
    this.drawFooter();
    const buffered = this.pendingPrints.splice(0);
    for (const text of buffered) this.print(text);
  }

  // ─── Replay + tail ───

  private eventsPath(): string {
    return join(getPathManager().local(this.activeBrain).sessionsDir(), this.activeSession, "events.jsonl");
  }

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
      this.tailer.offset = Buffer.byteLength(raw, "utf-8");
    } else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "", "utf-8");
    }

    this.tailer.start();
    this.subscribeLiveBus();
  }

  // ─── Switch session ───

  async switchTo(brainId: string, sessionId: string): Promise<void> {
    this.tailer.stop();
    this.tailer.offset = 0;
    this.unsubscribeLiveBus();
    this.activeBrain   = brainId;
    this.activeSession = sessionId;
    this.statusBar.setContext(brainId, sessionId);
    this.streaming = makeStreamingState();
    this.setThinking(false);
    this.subscribeContext(brainId);
    await this.config.writeSession(brainId, sessionId);
    await this.config.writeActiveBrain(brainId);
    this.footer.resetScrollRegion();
    clearScreen();
    this.footer.setupScrollRegion();
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
    // Ask the terminal to distinguish modified keys so Shift+Enter sends a
    // unique sequence instead of plain \r.
    //
    // \x1b[=1u  — kitty progressive keyboard protocol (kitty, WezTerm, foot…)
    //             Shift+Enter → \x1b[13;2u
    // \x1b[>4;2m — XTerm modifyOtherKeys mode 2 (xterm, VTE-based, most SSH)
    //             Shift+Enter → \x1b[27;2;13~
    //
    // Alt+Enter (\x1b\r) is handled as a universal fallback regardless of
    // which protocol fires, since any terminal passes ESC+CR in raw mode.
    process.stdout.write("\x1b[=1u");
    process.stdout.write("\x1b[>4;2m");
    this.drawFooter();

    process.stdin.on("data", (chunk: string) => {
      // Paste detection: arrives as one large chunk containing newlines.
      // A real Enter is just "\r" or "\n" (length 1).
      // An escape sequence starts with \x1b — not a paste.
      const hasNL = chunk.includes("\n") || chunk.includes("\r");
      if (chunk.length > 1 && hasNL && chunk.charCodeAt(0) !== 27) {
        const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
        this.input.appendPaste(normalized);
        this.redrawInput();
        return;
      }

      let i = 0;
      while (i < chunk.length) {
        const code = chunk.charCodeAt(i);

        if (code === 27) {
          if (i + 1 < chunk.length && chunk[i + 1] === "[") {
            let seq = "\x1b[";
            i += 2;
            while (i < chunk.length && !/[A-Za-z~]/.test(chunk[i])) seq += chunk[i++];
            if (i < chunk.length) seq += chunk[i++];
            this.handleEscapeSeq(seq);
          } else if (i + 1 < chunk.length && (chunk[i + 1] === "\r" || chunk[i + 1] === "\n")) {
            // Alt+Enter (\x1b\r or \x1b\n) — universal Shift+Enter fallback.
            // Works in any terminal regardless of keyboard protocol support.
            i += 2;
            if (!this.overlay) { this.input.insertNewline(); this.redrawInput(); }
          } else {
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

  private handleEscapeSeq(seq: string): void {
    if (this.overlay) {
      if (seq === "\x1b[A") { this.overlay.moveUp();   return; }
      if (seq === "\x1b[B") { this.overlay.moveDown(); return; }
      return;
    }
    if (seq === "\x1b[A") {
      this.input.set(this.input.navigate(1));
      this.redrawInput();
    } else if (seq === "\x1b[B") {
      this.input.set(this.input.navigate(-1));
      this.redrawInput();
    } else if (seq === "\x1b[C") {          // right arrow
      this.input.moveRight();
      this.redrawInput();
    } else if (seq === "\x1b[D") {          // left arrow
      this.input.moveLeft();
      this.redrawInput();
    } else if (
      seq === "\x1b[13;2u"   ||  // Shift+Enter        (kitty protocol)
      seq === "\x1b[27;2;13~" || // Shift+Enter        (XTerm modifyOtherKeys)
      seq === "\x1b[13;5u"   ||  // Ctrl+Enter         (kitty)
      seq === "\x1b[13;6u"       // Ctrl+Shift+Enter   (kitty)
    ) {
      this.input.insertNewline();
      this.redrawInput();
    }
  }

  private handleRawChar(ch: string): void {
    const code = ch.charCodeAt(0);

    if (this.overlay) {
      if (code === 13 || code === 10) { this.confirmOverlay(); return; }
      if (code === 3) { process.kill(process.pid, "SIGINT"); return; }
      return;
    }

    if (code === 3)  { process.kill(process.pid, "SIGINT"); return; }
    if (code === 4)  { if (!this.input.content) process.kill(process.pid, "SIGINT"); return; }
    if (code === 21) { this.input.clear(); this.redrawInput(); return; } // Ctrl+U

    if (code === 127 || code === 8) { // Backspace
      this.input.backspace();
      this.redrawInput();
      return;
    }

    if (code === 10) { // Ctrl+J — insert newline (soft line break)
      this.input.insertNewline();
      this.redrawInput();
      return;
    }

    if (code === 13) { // Enter — submit
      const text     = this.input.content.trim();
      const segments = this.input.snapshot;
      this.input.clear();
      // Redraw the now-empty input area immediately (shows › with no text).
      this.redrawInput();
      if (text) {
        this.input.pushHistory(text);
        this.handleLine(text, segments);
      }
      return;
    }

    if (code >= 32) { // Printable
      this.input.appendChar(ch);
      this.redrawInput();
    }
  }

  // ─── Overlay confirm ───

  private async confirmOverlay(): Promise<void> {
    if (!this.overlay || !this.overlayOnConfirm) return;
    const idx     = this.overlay.selectedIndex;
    const handler = this.overlayOnConfirm;
    this.closeOverlay();
    await handler(idx);
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

    if (trimmed === "/brains")           { await showBrainsOverlay(this); return; }
    if (trimmed.startsWith("/sessions")) { await showSessionsOverlay(this, trimmed.split(/\s+/)[1]); return; }
    if (trimmed === "/clear") {
      this.footer.resetScrollRegion();
      clearScreen();
      this.footer.setupScrollRegion();
      this.drawFooter();
      return;
    }

    if (trimmed.startsWith("/")) {
      const cmd = parseCommand(trimmed);
      if (cmd && this.activeBrain) {
        this.callbacks.onBrainCommand(this.activeBrain, cmd.toolName, cmd.args);
        const ev: RendererEvent = { k: "command", brain: this.activeBrain, toolName: cmd.toolName, ts: Date.now() };
        const rendered = formatEvent(ev);
        if (rendered) this.print(rendered);
        const evPath = this.eventsPath();
        appendFile(evPath, JSON.stringify(ev) + "\n", "utf-8").catch(() => {});
        this.tailer.offset += Buffer.byteLength(JSON.stringify(ev) + "\n", "utf-8");
      } else if (!this.activeBrain) {
        this.print(`${C.dim}⚠ 没有激活的 brain，命令未发送${C.reset}\n`);
      } else {
        this.print(`${C.dim}⚠ 无法解析命令: ${trimmed}${C.reset}\n`);
      }
      return;
    }

    if (this.activeBrain) {
      const ev: RendererEvent = { k: "user_input", text: trimmed, segments, ts: Date.now() };
      const rendered = formatEvent(ev);
      if (rendered) this.print(rendered);

      const evPath = this.eventsPath();
      appendFile(evPath, JSON.stringify(ev) + "\n", "utf-8").catch(() => {});
      this.tailer.offset += Buffer.byteLength(JSON.stringify(ev) + "\n", "utf-8");

      this.callbacks.onUserInput(this.activeBrain, trimmed);
    }
  }
}
