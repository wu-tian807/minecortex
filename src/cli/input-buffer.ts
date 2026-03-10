/** @desc InputBuffer — manages typed/pasted input segments and command history */

import { calcDisplayWidth } from "./ansi.js";
import type { InputSegment } from "./events.js";

export class InputBuffer {
  private segments: InputSegment[] = [];
  private history: string[] = [];
  private historyIdx = -1;
  private cursorPos = 0; // character offset in content string (0..content.length)

  // ─── Content accessors ───

  get content(): string {
    return this.segments.map(s => s.content).join("");
  }

  get cursor(): number {
    return this.cursorPos;
  }

  /** Shallow snapshot of current segments (safe to pass as event payload). */
  get snapshot(): InputSegment[] {
    return this.segments.map(s => ({ ...s }));
  }

  // ─── Segment helpers ───

  private _findSegmentAt(pos: number): { segIdx: number; segOffset: number; seg: InputSegment } | null {
    let offset = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const len = seg.content.length;
      if (pos >= offset && pos < offset + len) {
        return { segIdx: i, segOffset: offset, seg };
      }
      offset += len;
    }
    return null;
  }

  /** Insert a single character at content offset `pos`. */
  private _insertAt(pos: number, ch: string): void {
    let offset = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const len = seg.content.length;
      if (pos >= offset && pos <= offset + len) {
        if (seg.type === "text") {
          const rel = pos - offset;
          seg.content = seg.content.slice(0, rel) + ch + seg.content.slice(rel);
        } else {
          // paste is atomic — insert new text segment before it
          this.segments.splice(i, 0, { type: "text", content: ch });
        }
        return;
      }
      offset += len;
    }
    // append at end
    const last = this.segments.at(-1);
    if (last?.type === "text") { last.content += ch; }
    else                        { this.segments.push({ type: "text", content: ch }); }
  }

  /** Delete the text character at content offset `pos` (only called for non-paste positions). */
  private _deleteAt(pos: number): void {
    let offset = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const len = seg.content.length;
      if (pos >= offset && pos < offset + len) {
        const rel = pos - offset;
        seg.content = seg.content.slice(0, rel) + seg.content.slice(rel + 1);
        if (seg.content.length === 0) this.segments.splice(i, 1);
        return;
      }
      offset += len;
    }
  }

  /** Insert a paste segment at content offset `pos`, splitting any text segment if needed. */
  private _insertPasteAt(pos: number, text: string): void {
    let offset = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const len = seg.content.length;
      if (pos >= offset && pos <= offset + len) {
        if (seg.type === "text") {
          const rel = pos - offset;
          const before = seg.content.slice(0, rel);
          const after  = seg.content.slice(rel);
          const newSegs: InputSegment[] = [];
          if (before) newSegs.push({ type: "text", content: before });
          newSegs.push({ type: "paste", content: text });
          if (after)  newSegs.push({ type: "text", content: after });
          this.segments.splice(i, 1, ...newSegs);
        } else {
          // insert paste before the existing paste segment
          this.segments.splice(i, 0, { type: "paste", content: text });
        }
        return;
      }
      offset += len;
    }
    this.segments.push({ type: "paste", content: text });
  }

  // ─── Mutation ───

  appendChar(ch: string): void {
    this._insertAt(this.cursorPos, ch);
    this.cursorPos++;
  }

  appendPaste(text: string): void {
    this._insertPasteAt(this.cursorPos, text);
    this.cursorPos += text.length;
  }

  /** Insert a literal newline at cursor position (for multiline input). */
  insertNewline(): void {
    this._insertAt(this.cursorPos, "\n");
    this.cursorPos++;
  }

  backspace(): void {
    if (this.cursorPos === 0) return;
    const deletePos = this.cursorPos - 1;
    const found = this._findSegmentAt(deletePos);
    if (found && found.seg.type === "paste") {
      // delete entire paste block atomically, jump cursor to its start
      this.segments.splice(found.segIdx, 1);
      this.cursorPos = found.segOffset;
    } else {
      this._deleteAt(deletePos);
      this.cursorPos--;
    }
  }

  clear(): void { this.segments = []; this.cursorPos = 0; }

  set(text: string): void {
    this.segments  = text ? [{ type: "text", content: text }] : [];
    this.cursorPos = text.length;
  }

  // ─── Cursor movement ───

  /** Move cursor one position left. Paste blocks are treated as atomic (skip whole block). */
  moveLeft(): void {
    if (this.cursorPos === 0) return;
    const found = this._findSegmentAt(this.cursorPos - 1);
    if (found && found.seg.type === "paste") {
      // jump to before the paste block
      this.cursorPos = found.segOffset;
    } else {
      this.cursorPos--;
    }
  }

  /** Move cursor one position right. Paste blocks are treated as atomic (skip whole block). */
  moveRight(): void {
    if (this.cursorPos >= this.content.length) return;
    const found = this._findSegmentAt(this.cursorPos);
    if (found && found.seg.type === "paste") {
      // jump to after the paste block
      this.cursorPos = found.segOffset + found.seg.content.length;
    } else {
      this.cursorPos++;
    }
  }

  // ─── Display ───

  /**
   * Build one display string per logical line of input.
   * Text segments are split at `\n`; paste blocks are rendered inline on the
   * current line (they never introduce a line break in the display).
   */
  buildDisplayLines(): string[] {
    const lines: string[] = [""];
    for (const seg of this.segments) {
      if (seg.type === "paste") {
        const count = seg.content.split("\n").length;
        lines[lines.length - 1] += `\x1b[44;97m[已粘贴 ${count} 行]\x1b[0m`;
      } else {
        const parts = seg.content.split("\n");
        lines[lines.length - 1] += parts[0];
        for (let i = 1; i < parts.length; i++) lines.push(parts[i]);
      }
    }
    return lines;
  }

  /**
   * Return the cursor's position within the multiline display:
   *   lineIdx  — 0-based index of the input display line the cursor is on
   *   colWidth — visible display-column width of text on that line before the cursor
   */
  cursorDisplayPos(): { lineIdx: number; colWidth: number } {
    let offset      = 0;
    let lineIdx     = 0;
    let lineDisplay = ""; // display text of current line accumulated up to cursor

    for (const seg of this.segments) {
      if (offset >= this.cursorPos) break;

      if (seg.type === "paste") {
        const len   = seg.content.length;
        const count = seg.content.split("\n").length;
        lineDisplay += `[已粘贴 ${count} 行]`;
        offset += len;
      } else {
        const take  = Math.min(seg.content.length, this.cursorPos - offset);
        const slice = seg.content.slice(0, take);
        const parts = slice.split("\n");
        for (let i = 0; i < parts.length - 1; i++) {
          lineIdx++;
          lineDisplay = "";
        }
        lineDisplay += parts[parts.length - 1];
        offset += take;
      }
    }

    return { lineIdx, colWidth: calcDisplayWidth(lineDisplay) };
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
