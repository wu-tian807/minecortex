/** @desc 统一事件总线 — 合并了原 BrainBus 的脑间路由功能 */

import type { Event, EventQueueInterface } from "./types.js";

type EventHandler = (event: Event) => void;

export class EventBus {
  private observers = new Set<EventHandler>();
  /** Maps brainId → EventQueue for cross-brain routing */
  private brainQueueMap = new Map<string, EventQueueInterface>();

  /** Register an observer that receives every emit()-ed event. Returns an unsubscribe fn. */
  observe(handler: EventHandler): () => void {
    this.observers.add(handler);
    return () => this.observers.delete(handler);
  }

  register(brainId: string, queue: EventQueueInterface): void {
    this.brainQueueMap.set(brainId, queue);
  }

  unregister(brainId: string): void {
    this.brainQueueMap.delete(brainId);
  }

  emit(event: Event, sourceBrainId?: string): void {
    for (const h of this.observers) h(event);

    if (event.to && event.to !== sourceBrainId) {
      this.route(event, event.to, sourceBrainId);
    }
  }

  /** Push directly into a brain's own queue without going through global handlers or routing.
   *  Use for events that should only be seen by that brain (e.g. thought_result). */
  emitToSelf(event: Event, brainId: string): void {
    const queue = this.brainQueueMap.get(brainId);
    if (queue) queue.push(event);
  }

  /** Unblock a brain's event loop so it re-checks commandQueue. Filtered out before LLM turn. */
  nudge(brainId: string): void {
    const queue = this.brainQueueMap.get(brainId);
    if (queue) {
      queue.push({ source: "_system", type: "_nudge", payload: {}, ts: Date.now() });
    }
  }

  private route(event: Event, to: string, fromBrainId?: string): void {
    if (to === "*") {
      for (const [id, queue] of this.brainQueueMap) {
        if (id !== fromBrainId) queue.push(event);
      }
    } else {
      const queue = this.brainQueueMap.get(to);
      if (queue) queue.push(event);
    }
  }
}
