/** @desc 全局事件总线 — 接收 EventSource 的原始事件并分发 */

import type { Event } from "./types.js";

type EventHandler = (event: Event) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private globalHandlers = new Set<EventHandler>();

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

  emit(event: Event): void {
    const sourceHandlers = this.handlers.get(event.source);
    if (sourceHandlers) {
      for (const h of sourceHandlers) h(event);
    }
    for (const h of this.globalHandlers) h(event);
  }
}
