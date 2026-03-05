/** @desc StatusBar — renders the single-line status strip above the input prompt */

import { C } from "./ansi.js";
import { ContextRing } from "./context-ring.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export class StatusBar {
  readonly contextRing = new ContextRing();

  private brain   = "";
  private session = "";

  // Thinking / spinner
  private thinking     = false;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  /** Update brain + session labels shown in the bar. */
  setContext(brain: string, session: string): void {
    this.brain   = brain;
    this.session = session;
  }

  setThinking(v: boolean, onTick: () => void): void {
    if (v === this.thinking) return;
    this.thinking = v;
    if (v) {
      this.spinnerFrame = 0;
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        onTick();
      }, 100);
    } else {
      if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
    }
  }

  isThinking(): boolean { return this.thinking; }

  stop(): void {
    this.setThinking(false, () => {});
    this.contextRing.unsubscribe();
  }

  /**
   * Render the status bar as a single ANSI-formatted string (no newline).
   * Layout:  brain: X  session: Y  ◑ 48%  ⠙
   * The ring and spinner sit right next to the session label — no right-push.
   */
  render(): string {
    const brainLabel   = this.brain   || "—";
    const sessionLabel = this.session ? `…${this.session.slice(-14)}` : "—";

    const ring    = this.contextRing.render();
    const spinner = this.thinking ? `  ${C.yellow}${SPINNER_FRAMES[this.spinnerFrame]}${C.reset}` : "";

    return (
      `${C.dim}brain:${C.reset} ${C.bold}${brainLabel}${C.reset}` +
      `${C.dim}  session:${C.reset} ${C.dim}${sessionLabel}${C.reset}` +
      `  ${ring.fmt}` +
      spinner
    );
  }
}
