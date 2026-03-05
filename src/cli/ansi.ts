/** @desc ANSI escape codes and cursor helpers */

import * as readline from "node:readline";

export const C = {
  reset:   "\x1b[0m",
  dim:     "\x1b[90m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  yellow:  "\x1b[33m",
  bold:    "\x1b[1m",
} as const;

// ─── Cursor helpers (all operate on process.stdout) ───

export function cursorUp(n: number): void {
  if (n > 0) readline.moveCursor(process.stdout, 0, -n);
}
export function cursorDown(n: number): void {
  if (n > 0) readline.moveCursor(process.stdout, 0, n);
}
export function cursorToCol0(): void {
  readline.cursorTo(process.stdout, 0);
}
export function cursorToCol(n: number): void {
  readline.cursorTo(process.stdout, n);
}
export function clearToEnd(): void {
  process.stdout.write("\x1b[J");
}
export function clearLine(): void {
  readline.clearLine(process.stdout, 0);
}
