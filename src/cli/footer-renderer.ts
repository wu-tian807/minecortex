/**
 * FooterRenderer — owns the terminal's last 3 rows.
 *
 * Layout (absolute row numbers, 1-based):
 *   row N-2 : thinking preview  (💭 ...text...)
 *   row N-1 : status bar        (brain / session / spinner / context ring)
 *   row N   : input line        (› <user input>)
 *
 * The scroll region is set to rows 1–(N-3) so that content scrolls freely
 * inside the content area and NEVER overwrites the footer rows.
 *
 * All public methods are safe to call at any time — they save and restore
 * the terminal cursor so that callers (including streaming text writers)
 * are not disturbed.
 */

import { clearLine, clearToEnd } from "./ansi.js";

export interface FooterContent {
  thinkingPreview(): string;
  statusBarLine(): string;
  inputLine(): string;
}

export class FooterRenderer {
  private isTTY: boolean;

  constructor(isTTY: boolean) {
    this.isTTY = isTTY;
  }

  // ─── Scroll region ───

  /** Reserve last 3 rows for footer; content scrolls in rows 1..(N-3). */
  setupScrollRegion(): void {
    if (!this.isTTY) return;
    const rows = this.rows();
    const contentBottom = Math.max(3, rows - 3);
    process.stdout.write(`\x1b[1;${contentBottom}r`);
  }

  /** Reset scroll region to full screen (call before clearScreen + replay). */
  resetScrollRegion(): void {
    if (!this.isTTY) return;
    const rows = this.rows();
    process.stdout.write(`\x1b[1;${rows}r`);
  }

  // ─── Footer drawing ───

  /**
   * Redraw all three footer rows using absolute cursor positioning.
   * Saves and restores the cursor so any ongoing streaming is undisturbed.
   */
  draw(content: FooterContent): void {
    if (!this.isTTY) return;
    const rows = this.rows();
    process.stdout.write("\x1b[s"); // save cursor

    process.stdout.write(`\x1b[${rows - 2};1H`); clearLine();
    process.stdout.write(content.thinkingPreview());

    process.stdout.write(`\x1b[${rows - 1};1H`); clearLine();
    process.stdout.write(content.statusBarLine());

    process.stdout.write(`\x1b[${rows};1H`); clearLine();
    process.stdout.write(content.inputLine());

    process.stdout.write("\x1b[u"); // restore cursor
  }

  /**
   * Update only the status bar row (row N-1).
   * Used for spinner animation during streaming — cheaper than a full redraw.
   */
  updateStatusBar(line: string): void {
    if (!this.isTTY) return;
    process.stdout.write("\x1b[s");
    process.stdout.write(`\x1b[${this.rows() - 1};1H`); clearLine();
    process.stdout.write(line);
    process.stdout.write("\x1b[u");
  }

  /**
   * Redraw the input line (row N) only.
   * Saves and restores cursor — safe to call while model is streaming.
   */
  updateInputLine(line: string): void {
    if (!this.isTTY) return;
    process.stdout.write("\x1b[s");
    process.stdout.write(`\x1b[${this.rows()};1H`); clearLine();
    process.stdout.write(line);
    process.stdout.write("\x1b[u");
  }

  /** Erase all three footer rows (does not redraw). Cursor is saved/restored. */
  clear(): void {
    if (!this.isTTY) return;
    process.stdout.write("\x1b[s");
    process.stdout.write(`\x1b[${this.rows() - 2};1H`);
    clearToEnd();
    process.stdout.write("\x1b[u");
  }

  // ─── Content area ───

  /**
   * Return the row number at the bottom of the content area (= N-3).
   * Use this as the write position for `print()` calls so that new content
   * naturally scrolls upward within the scroll region.
   */
  contentBottom(): number {
    return Math.max(1, this.rows() - 3);
  }

  // ─── Helpers ───

  private rows(): number {
    return process.stdout.rows ?? 24;
  }
}
