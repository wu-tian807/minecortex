/**
 * FooterRenderer — owns the terminal's last (2 + inputLineCount) rows.
 *
 * Layout (absolute row numbers, 1-based, N = process.stdout.rows):
 *   row N - inputLineCount - 1 : thinking preview  (💭 ...text...)
 *   row N - inputLineCount     : status bar         (brain / session / spinner / ring)
 *   row N - inputLineCount + 1 : prompt + input line 0
 *   ...
 *   row N                      : input line (inputLineCount - 1)
 *
 * The scroll region is set to rows 1–(N - inputLineCount - 2) so content
 * scrolls freely and never overwrites footer rows.
 *
 * All public methods save/restore the cursor unless a `cursor` argument is
 * provided, in which case the terminal cursor is left at that position.
 */

import { clearLine, clearToEnd } from "./ansi.js";

export interface FooterContent {
  thinkingPreview(): string;
  statusBarLine(): string;
  /**
   * Full input display string, including PROMPT prefix.
   * Multiple logical lines are joined with "\n" for multiline input support.
   */
  inputLine(): string;
}

export interface FooterCursorPos {
  /** 0-based index of the input line the cursor is on. */
  lineIdx: number;
  /** 1-indexed terminal column. */
  col: number;
}

export class FooterRenderer {
  private isTTY: boolean;
  /** How many rows the input area currently occupies (≥ 1). */
  private inputLineCount = 1;

  constructor(isTTY: boolean) {
    this.isTTY = isTTY;
  }

  // ─── Scroll region ───

  /** Reserve (2 + inputLineCount) rows for footer; content scrolls in 1..(N-2-inputLineCount). */
  setupScrollRegion(inputLineCount = 1): void {
    if (!this.isTTY) return;
    this.inputLineCount = Math.max(1, inputLineCount);
    const rows = this.rows();
    process.stdout.write(`\x1b[1;${Math.max(3, rows - 2 - this.inputLineCount)}r`);
  }

  /** Reset scroll region to full screen (call before clearScreen + replay). */
  resetScrollRegion(): void {
    if (!this.isTTY) return;
    process.stdout.write(`\x1b[1;${this.rows()}r`);
  }

  // ─── Footer drawing ───

  /**
   * Redraw all footer rows.
   * When `cursor` is provided the terminal cursor is left at that position in
   * the input area. Otherwise the cursor is saved/restored (streaming-safe).
   */
  draw(content: FooterContent, cursor?: FooterCursorPos): void {
    if (!this.isTTY) return;
    const rows       = this.rows();
    const inputLines = content.inputLine().split("\n");
    const nInput     = Math.max(1, inputLines.length);
    this.inputLineCount = nInput;

    process.stdout.write("\x1b[s");

    const statusRow = rows - nInput;
    process.stdout.write(`\x1b[${statusRow - 1};1H`); clearLine();
    process.stdout.write(content.thinkingPreview());
    process.stdout.write(`\x1b[${statusRow};1H`);     clearLine();
    process.stdout.write(content.statusBarLine());
    for (let i = 0; i < nInput; i++) {
      process.stdout.write(`\x1b[${statusRow + 1 + i};1H`); clearLine();
      process.stdout.write(inputLines[i] ?? "");
    }

    if (cursor) {
      process.stdout.write(`\x1b[${statusRow + 1 + cursor.lineIdx};${cursor.col}H`);
    } else {
      process.stdout.write("\x1b[u");
    }
  }

  /**
   * Update only the status bar row.
   * Used for spinner animation during streaming — cheaper than a full redraw.
   */
  updateStatusBar(line: string): void {
    if (!this.isTTY) return;
    process.stdout.write("\x1b[s");
    process.stdout.write(`\x1b[${this.rows() - this.inputLineCount};1H`); clearLine();
    process.stdout.write(line);
    process.stdout.write("\x1b[u");
  }

  /**
   * Redraw the input rows only (does not touch thinking/status rows).
   * `line` follows the same convention as `FooterContent.inputLine()` — multiple
   * logical lines joined with "\n".  Call setupScrollRegion + full draw first
   * whenever the line count changes.
   */
  updateInputLine(line: string, cursor?: FooterCursorPos): void {
    if (!this.isTTY) return;
    const rows       = this.rows();
    const inputLines = line.split("\n");
    const statusRow  = rows - this.inputLineCount;

    process.stdout.write("\x1b[s");
    for (let i = 0; i < this.inputLineCount; i++) {
      process.stdout.write(`\x1b[${statusRow + 1 + i};1H`); clearLine();
      process.stdout.write(inputLines[i] ?? "");
    }

    if (cursor) {
      process.stdout.write(`\x1b[${statusRow + 1 + cursor.lineIdx};${cursor.col}H`);
    } else {
      process.stdout.write("\x1b[u");
    }
  }

  /** Erase all footer rows (does not redraw). Cursor is saved/restored. */
  clear(): void {
    if (!this.isTTY) return;
    process.stdout.write("\x1b[s");
    process.stdout.write(`\x1b[${this.rows() - this.inputLineCount - 1};1H`);
    clearToEnd();
    process.stdout.write("\x1b[u");
  }

  // ─── Content area ───

  /**
   * Return the row number at the bottom of the content area (= N - 2 - inputLineCount).
   * Use this as the write position for `print()` / `appendTextChunk()` calls.
   */
  contentBottom(): number {
    return Math.max(1, this.rows() - 2 - this.inputLineCount);
  }

  // ─── Helpers ───

  private rows(): number {
    return process.stdout.rows ?? 24;
  }
}
