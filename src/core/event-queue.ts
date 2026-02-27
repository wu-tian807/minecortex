/** @desc EventQueue — per-brain event accumulator with blocking wait for agent loop */

import type { Event, EventQueueInterface } from "./types.js";

const MAX_EVENTS = 50;

export class EventQueue implements EventQueueInterface {
  private queue: Event[] = [];
  private waiter: ((event: Event) => void) | null = null;

  push(event: Event): void {
    this.queue.push(event);
    if (this.queue.length > MAX_EVENTS) {
      this.queue.shift();
    }
    if (!event.silent && this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(event);
    }
  }

  /** Block until a non-silent event arrives; returns the triggering event (peek, not removed) */
  waitForEvent(signal?: AbortSignal): Promise<Event> {
    const trigger = this.queue.find(e => !e.silent);
    if (trigger) {
      return Promise.resolve(trigger);
    }
    return new Promise<Event>((resolve, reject) => {
      this.waiter = resolve;
      signal?.addEventListener("abort", () => {
        this.waiter = null;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  /** Drain all queued events (silent + non-silent), sorted by priority then timestamp */
  drain(): Event[] {
    if (this.queue.length === 0) return [];
    const batch = [...this.queue];
    this.queue.length = 0;
    batch.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1) || a.ts - b.ts);
    return batch;
  }

  pending(): number {
    return this.queue.length;
  }
}
