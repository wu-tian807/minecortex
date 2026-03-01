/** @desc 统一事件总线 — 合并了原 BrainBus 的脑间路由功能 */

import type { Event, EventQueueInterface } from "./types.js";

type EventHandler = (event: Event) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private globalHandlers = new Set<EventHandler>();
  private brainQueues = new Map<string, EventQueueInterface>();

  on(source: string, handler: EventHandler): void {
    if (!this.handlers.has(source)) {
      this.handlers.set(source, new Set());
    }
    this.handlers.get(source)!.add(handler);
  }

  onAny(handler: EventHandler): void {
    this.globalHandlers.add(handler);
  }

  off(source: string, handler: EventHandler): void {
    this.handlers.get(source)?.delete(handler);
  }

  register(brainId: string, queue: EventQueueInterface): void {
    this.brainQueues.set(brainId, queue);
  }

  unregister(brainId: string): void {
    this.brainQueues.delete(brainId);
  }

  emit(event: Event, sourceBrainId?: string): void {
    const sourceHandlers = this.handlers.get(event.source);
    if (sourceHandlers) {
      for (const h of sourceHandlers) h(event);
    }
    for (const h of this.globalHandlers) h(event);

    const to = (event.payload as any)?.to as string | undefined;
    if (to && to !== sourceBrainId) {
      this.route(event, to, sourceBrainId);
    }
  }

  /** Push a _wake event to a brain's queue to unblock its event loop. */
  wake(brainId: string): void {
    const queue = this.brainQueues.get(brainId);
    if (queue) {
      queue.push({ source: "_system", type: "_wake", payload: {}, ts: Date.now(), silent: false, priority: -1 });
    }
  }

  private route(event: Event, to: string, fromBrainId?: string): void {
    if (to === "*") {
      for (const [id, queue] of this.brainQueues) {
        if (id !== fromBrainId) queue.push(event);
      }
    } else {
      const queue = this.brainQueues.get(to);
      if (queue) queue.push(event);
    }
  }
}
