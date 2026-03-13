/** @desc EventTailer — watches events.jsonl for new lines and session.json for session switches */

import { watch, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { getPathManager } from "../fs/index.js";
import { watchCurrentSessionId } from "../session/session-pointer.js";
import { type RendererEvent, parseRendererEvent } from "./events.js";

export class EventTailer {
  /** Byte offset of the last read position in events.jsonl. */
  offset = 0;

  private fsWatcher:      ReturnType<typeof watch> | null = null;
  private sessionWatcher: ReturnType<typeof watch> | null = null;

  constructor(
    /** Returns the current events.jsonl path (changes on session switch). */
    private getEventsPath:    () => string,
    /** Returns the currently active brain id. */
    private getActiveBrain:   () => string,
    /** Returns the currently active session id. */
    private getActiveSession: () => string,
    /**
     * Called for each new event parsed from the file.
     * `nextByteOffset` is the byte position just after this event's line (including its \n).
     * The renderer currently processes live events incrementally, but we still expose
     * the offset so callers can coordinate any future jump-forward logic safely.
     */
    private onEvent:          (ev: RendererEvent, isLive: boolean, nextByteOffset: number) => void,
    /** Called when session.json indicates a different active session. */
    private onSessionSwitch:  (brainId: string, sessionId: string) => void,
  ) {}

  /** Start watching the current events.jsonl and session.json. Stops any previous watchers first. */
  start(): void {
    this.stop();
    const path = this.getEventsPath();
    if (!existsSync(path)) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    this.fsWatcher = watch(path, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => this.readNewLines(), 50);
    });

    this.watchSessionJson();
  }

  /** Stop all watchers. */
  stop(): void {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    this.sessionWatcher?.close();
    this.sessionWatcher = null;
  }

  // ─── Private ───

  private watchSessionJson(): void {
    this.sessionWatcher?.close();
    this.sessionWatcher = null;
    const brain = this.getActiveBrain();
    if (!brain) return;
    this.sessionWatcher = watchCurrentSessionId({
      pathManager: getPathManager(),
      brainId: brain,
      initialSessionId: this.getActiveSession(),
      debounceMs: 120,
      onChange: (sessionId) => {
        this.onSessionSwitch(brain, sessionId);
      },
    });
  }

  private async readNewLines(): Promise<void> {
    try {
      const raw   = await readFile(this.getEventsPath(), "utf-8");
      const bytes = Buffer.byteLength(raw, "utf-8");
      if (bytes <= this.offset) return;

      // Process line-by-line while tracking byte positions.
      // We do NOT set this.offset = bytes upfront: instead we advance it per-line.
      // This preserves the ability for onEvent handlers to jump the tail offset
      // forward explicitly if they ever need to resynchronize with the file.
      const buf = Buffer.from(raw, "utf-8");
      let pos = this.offset;

      while (pos < bytes) {
        // Find end of line (next \n or EOF).
        let lineEnd = pos;
        while (lineEnd < bytes && buf[lineEnd] !== 0x0A) lineEnd++;
        const nextPos = lineEnd < bytes ? lineEnd + 1 : bytes; // byte after \n

        const line = buf.subarray(pos, lineEnd).toString("utf-8").trim();
        if (line) {
          const ev = parseRendererEvent(line);
          if (ev && ev.k !== "user_input") {
            this.onEvent(ev, true, nextPos);
          }
        }

        // If the callback externally advanced this.offset, jump to the new offset —
        // it already handled the events up to there.
        if (this.offset > pos) {
          pos = this.offset;
        } else {
          this.offset = nextPos;
          pos = nextPos;
        }
      }
    } catch { /* file not ready */ }
  }
}
