/** @desc InputBuffer — manages typed/pasted input segments and command history */

import type { InputSegment } from "./events.js";

export class InputBuffer {
  private segments: InputSegment[] = [];
  private history: string[] = [];
  private historyIdx = -1;

  // ─── Content accessors ───

  get content(): string {
    return this.segments.map(s => s.content).join("");
  }

  /** Shallow snapshot of current segments (safe to pass as event payload). */
  get snapshot(): InputSegment[] {
    return this.segments.map(s => ({ ...s }));
  }

  // ─── Mutation ───

  appendChar(ch: string): void {
    const last = this.segments.at(-1);
    if (last?.type === "text") { last.content += ch; }
    else                        { this.segments.push({ type: "text", content: ch }); }
  }

  appendPaste(text: string): void {
    this.segments.push({ type: "paste", content: text });
  }

  backspace(): void {
    const last = this.segments.at(-1);
    if (!last) return;
    if (last.type === "paste") {
      this.segments.pop();
    } else if (last.content.length > 1) {
      last.content = last.content.slice(0, -1);
    } else {
      this.segments.pop();
    }
  }

  clear(): void { this.segments = []; }

  set(text: string): void {
    this.segments = text ? [{ type: "text", content: text }] : [];
  }

  // ─── Display ───

  /** Build the display string shown after the prompt (paste blocks rendered in blue). */
  buildDisplay(): string {
    let d = "";
    for (const seg of this.segments) {
      if (seg.type === "paste") {
        const lines = seg.content.split("\n").length;
        d += `\x1b[44;97m[已粘贴 ${lines} 行]\x1b[0m`;
      } else {
        d += seg.content;
      }
    }
    return d;
  }

  // ─── History ───

  /** Push to history (deduplicated) and reset navigation index. */
  pushHistory(text: string): void {
    if (this.history.at(-1) !== text) this.history.push(text);
    this.historyIdx = -1;
  }

  /**
   * Navigate history by delta (+1 = older, -1 = newer).
   * Returns the text to set as the current input.
   */
  navigate(delta: 1 | -1): string {
    this.historyIdx = Math.max(-1, Math.min(this.historyIdx + delta, this.history.length - 1));
    return this.historyIdx < 0
      ? ""
      : (this.history[this.history.length - 1 - this.historyIdx] ?? "");
  }
}
