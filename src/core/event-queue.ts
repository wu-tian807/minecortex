import type { Event, EventQueueInterface } from "./types.js";

const MAX_EVENTS = 50;

export class EventQueue implements EventQueueInterface {
  private queue: Event[] = [];
  private waiter: ((event: Event) => void) | null = null;
  private steerListeners = new Set<() => void>();

  push(event: Event): void {
    this.queue.push(event);
    if (this.queue.length > MAX_EVENTS) {
      this.queue.shift();
    }
    if (event.steer) {
      for (const cb of this.steerListeners) {
        try { cb(); } catch { /* listener error */ }
      }
    }
    if (!event.silent && this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(event);
    }
  }

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

  hasSteerEvent(): boolean {
    return this.queue.some(e => e.steer === true);
  }

  onSteer(cb: () => void): { dispose(): void } {
    this.steerListeners.add(cb);
    return {
      dispose: () => { this.steerListeners.delete(cb); },
    };
  }
}
