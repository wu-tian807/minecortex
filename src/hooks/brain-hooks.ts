/** BrainHooks — lifecycle hook registry for a single brain instance */

import { HookEvent, type HookCallback, type HookPayloadMap, type BrainHooksAPI } from "./types.js";

export class BrainHooks implements BrainHooksAPI {
  private listeners = new Map<HookEvent, Set<HookCallback<any>>>();

  on<E extends HookEvent>(event: E, cb: HookCallback<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** Internal — called by brain loop at lifecycle points. Not part of BrainHooksAPI. */
  emit<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch {
        /* hook error — never propagate to brain loop */
      }
    }
  }

  /** Remove all listeners (called on shutdown/free). */
  clear(): void {
    this.listeners.clear();
  }
}
