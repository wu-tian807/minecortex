/** @desc ContextBar — renders a simple block progress bar for context usage in the status bar */

import { C } from "./ansi.js";

const BAR_WIDTH = 8; // number of block segments

function buildBar(pct: number, color: string): { text: string; fmt: string } {
  const filled = Math.round(pct * BAR_WIDTH);
  const empty  = BAR_WIDTH - filled;
  const label  = `${Math.round(pct * 100)}%`.padStart(4);

  const barText = `▕${"█".repeat(filled)}${"░".repeat(empty)}▏ ${label}`;
  const barFmt  = `${C.dim}▕${C.reset}${color}${"█".repeat(filled)}${C.reset}${C.dim}${"░".repeat(empty)}▏${C.reset}${C.dim} ${label}${C.reset}`;

  return { text: barText, fmt: barFmt };
}

export interface ContextRingView {
  /** Plain-text string (used to measure display width for alignment) */
  text: string;
  /** ANSI-formatted string (written to stdout) */
  fmt: string;
}

export class ContextRing {
  private ratio: number | null = null;
  private unwatch: (() => void) | null = null;

  /** Called by the renderer whenever the status bar needs to be redrawn. */
  render(): ContextRingView {
    if (this.ratio === null) {
      // Placeholder: empty bar, shown before the first LLM call populates BrainBoard
      const barText = `▕${"░".repeat(BAR_WIDTH)}▏   —%`;
      const barFmt  = `${C.dim}▕${"░".repeat(BAR_WIDTH)}▏   —%${C.reset}`;
      return { text: barText, fmt: barFmt };
    }

    const pct   = Math.min(1, Math.max(0, this.ratio));
    const color = pct >= 0.9 ? "\x1b[91m"   // bright red
                : pct >= 0.7 ? C.red
                : pct >= 0.5 ? C.yellow
                : C.green;

    return buildBar(pct, color);
  }

  /**
   * Subscribe to context usage updates for `brainId`.
   * `watchFn` should return an unsubscribe callback (same contract as `RendererCallbacks.watchContextUsage`).
   * Any previous subscription is cleaned up first.
   */
  subscribe(
    brainId: string,
    watchFn: (brainId: string, cb: (ratio: number | null) => void) => () => void,
    onUpdate: () => void,
  ): void {
    this.unsubscribe();
    this.ratio = null;
    if (!brainId) return;

    this.unwatch = watchFn(brainId, (ratio) => {
      this.ratio = ratio;
      onUpdate();
    });
  }

  unsubscribe(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.ratio   = null;
  }
}
