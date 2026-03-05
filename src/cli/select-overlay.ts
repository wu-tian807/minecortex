/**
 * @desc SelectOverlay — inline arrow-key selection rendered below the input line.
 *
 * Layout (rendered below the sticky footer):
 *
 *   ╭─ title ──────────────────────────────╮
 *   │ ● item A  (hint)                     │   ← highlighted
 *   │   item B                             │
 *   │   item C                             │
 *   ╰── ↑↓ 移动  Enter 确认  Esc 取消 ────╯
 *
 * Cursor management:
 *   - show()    : writes "\n" to move past input line, then renders. lineCount tracks lines written.
 *   - moveUp/Down: clears overlay area and re-renders in place (differential-style).
 *   - clear()   : erases overlay area, moves cursor back to input line row.
 *
 * The caller (CLIRenderer) is responsible for redrawing the input line after clear().
 */

import * as readline from "node:readline";
import { C, cursorUp, cursorToCol0, clearToEnd } from "./ansi.js";

export interface SelectItem {
  label: string;
  hint?: string;
}

export class SelectOverlay {
  private items: SelectItem[];
  private idx: number;
  private title: string;
  /** Number of lines written during the last renderLines() call. */
  private lineCount = 0;

  constructor(title: string, items: SelectItem[], activeIdx = 0) {
    this.title = title;
    this.items = items;
    this.idx = Math.max(0, Math.min(activeIdx, items.length - 1));
  }

  get selected(): SelectItem | null { return this.items[this.idx] ?? null; }
  get selectedIndex(): number { return this.idx; }
  get isEmpty(): boolean { return this.items.length === 0; }

  // ─── Navigation ───

  moveUp(): void {
    if (this.idx > 0) { this.idx--; this.redraw(); }
  }

  moveDown(): void {
    if (this.idx < this.items.length - 1) { this.idx++; this.redraw(); }
  }

  // ─── Lifecycle ───

  /** Render overlay below the current line (call while cursor is on the input line). */
  show(): void {
    process.stdout.write("\n");   // advance past input line
    this.lineCount = 0;
    this.renderLines();
  }

  /** Erase the overlay and leave cursor on the input line (call before redrawInputLine). */
  clear(): void {
    if (this.lineCount > 0) {
      cursorUp(this.lineCount);
      cursorToCol0();
      clearToEnd();
      this.lineCount = 0;
    }
    // Move back to the input line (one row above where show() started writing)
    cursorUp(1);
  }

  // ─── Private rendering ───

  private renderLines(): void {
    const cols = process.stdout.columns ?? 80;

    // Compute box inner width
    const longestItem = this.items.reduce((m, it) => {
      const len = it.label.length + (it.hint ? 1 + it.hint.length : 0);
      return Math.max(m, len);
    }, 0);
    const hint = "↑↓ 移动  Enter 确认  Esc 取消";
    const minW  = Math.max(this.title.length + 4, hint.length + 4, longestItem + 6, 32);
    const innerW = Math.min(minW, cols - 4);

    const titleStr = ` ${this.title} `;
    const topBorder    = `╭─${titleStr}${"─".repeat(Math.max(0, innerW - titleStr.length - 2))}╮`;
    const bottomBorder = `╰${"─".repeat(Math.max(0, innerW - hint.length - 4))} ${hint} ╯`;

    const lines: string[] = [topBorder];

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const sel  = i === this.idx;

      const marker    = sel ? `${C.green}●${C.reset}` : " ";
      const labelRaw  = item.label.slice(0, innerW - 6);
      const labelFmt  = sel ? `${C.bold}${labelRaw}${C.reset}` : labelRaw;
      const hintRaw   = item.hint ? ` ${item.hint}` : "";
      const hintFmt   = item.hint ? ` ${C.dim}${item.hint}${C.reset}` : "";

      const contentLen = 2 + 2 + labelRaw.length + hintRaw.length; // "│ ● labelRaw hintRaw"
      const padding    = " ".repeat(Math.max(0, innerW - contentLen - 2));

      lines.push(`${C.dim}│${C.reset} ${marker} ${labelFmt}${hintFmt}${padding} ${C.dim}│${C.reset}`);
    }
    lines.push(bottomBorder);

    process.stdout.write(
      lines.map(l => `${C.dim}${l}${C.reset}`).join("\n") + "\n",
    );
    // Note: top/bottom border already wrapped in dim above, but dim on inner rows are fine too.
    // We overwrite the dim on the bold label via reset inside labelFmt.
    this.lineCount = lines.length;
  }

  private redraw(): void {
    cursorUp(this.lineCount);
    cursorToCol0();
    clearToEnd();
    this.lineCount = 0;
    this.renderLines();
  }
}
