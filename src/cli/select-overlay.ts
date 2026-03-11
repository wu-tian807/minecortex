/**
 * @desc SelectOverlay — inline arrow-key selection rendered at an absolute terminal row.
 *
 * Layout (rendered at startRow within the content area):
 *
 *   ╭─ title ──────────────────────────────╮
 *   │ ● item A  (hint)                     │   ← highlighted
 *   │   item B                             │
 *   │   item C                             │
 *   ╰── ↑↓ 移动  Enter 确认  Esc 取消 ────╯
 *
 * Cursor management:
 *   - show(startRow): renders at absolute terminal rows startRow..startRow+rowCount()-1.
 *   - moveUp/Down   : re-renders in place at the same absolute rows.
 *   - clear()       : erases all rows with absolute positioning.
 *
 * All rendering uses absolute cursor positioning (\x1b[row;1H) to work correctly
 * regardless of the scroll region or whether the cursor is at the terminal bottom.
 */

import * as readline from "node:readline";
import { C, clearToEnd } from "./ansi.js";

export interface SelectItem {
  label: string;
  hint?: string;
}

export class SelectOverlay {
  private items: SelectItem[];
  private idx: number;
  private title: string;
  /** Absolute terminal row (1-indexed) where the overlay starts. Set by show(). */
  private startRow = 1;

  constructor(title: string, items: SelectItem[], activeIdx = 0) {
    this.title = title;
    this.items = items;
    this.idx = Math.max(0, Math.min(activeIdx, items.length - 1));
  }

  get selected(): SelectItem | null { return this.items[this.idx] ?? null; }
  get selectedIndex(): number { return this.idx; }
  get isEmpty(): boolean { return this.items.length === 0; }

  /**
   * Number of terminal rows this overlay occupies: 2 borders + one row per item.
   * Use this to compute the startRow before calling show().
   */
  rowCount(): number { return this.items.length + 2; }

  // ─── Navigation ───

  moveUp(): void {
    if (this.idx > 0) { this.idx--; this.redraw(); }
  }

  moveDown(): void {
    if (this.idx < this.items.length - 1) { this.idx++; this.redraw(); }
  }

  // ─── Lifecycle ───

  /**
   * Render overlay at absolute terminal row `startRow`.
   * Uses absolute cursor positioning so it works regardless of scroll region.
   */
  show(startRow: number): void {
    this.startRow = startRow;
    this.renderLines();
  }

  /** Erase all overlay rows using absolute positioning. */
  clear(): void {
    process.stdout.write("\x1b[s");
    process.stdout.write(`\x1b[${this.startRow};1H`);
    clearToEnd();
    process.stdout.write("\x1b[u");
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

    // Render each line at its absolute row position.
    process.stdout.write("\x1b[s");
    for (let i = 0; i < lines.length; i++) {
      process.stdout.write(`\x1b[${this.startRow + i};1H`);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(`${C.dim}${lines[i]}${C.reset}`);
    }
    process.stdout.write("\x1b[u");
  }

  private redraw(): void {
    this.renderLines();
  }
}
