/** @desc 脑间消息总线 — 对齐 agentic_os MessageBus (send/broadcast/drain/pending) */

import type { BrainBusInterface, BusMessage } from "./types.js";

export class BrainBus implements BrainBusInterface {
  private queues = new Map<string, BusMessage[]>();
  private onMessageCallbacks: Array<(msg: BusMessage) => void> = [];

  send(msg: BusMessage): void {
    if (msg.to === "*") {
      this.broadcastRaw(msg);
    } else {
      this.enqueue(msg.to, msg);
    }
    for (const cb of this.onMessageCallbacks) cb(msg);
  }

  broadcast(from: string, content: string, summary: string): void {
    const msg: BusMessage = { from, to: "*", content, summary, ts: Date.now() };
    this.broadcastRaw(msg);
    for (const cb of this.onMessageCallbacks) cb(msg);
  }

  drain(brainId: string): BusMessage[] {
    const queue = this.queues.get(brainId);
    if (!queue || queue.length === 0) return [];
    const msgs = [...queue];
    queue.length = 0;
    return msgs;
  }

  pending(brainId: string): number {
    return this.queues.get(brainId)?.length ?? 0;
  }

  /** Register a brain so it can receive broadcasts */
  register(brainId: string): void {
    if (!this.queues.has(brainId)) {
      this.queues.set(brainId, []);
    }
  }

  /** Subscribe to all messages (used by Scheduler to detect bus triggers) */
  onMessage(cb: (msg: BusMessage) => void): void {
    this.onMessageCallbacks.push(cb);
  }

  private enqueue(brainId: string, msg: BusMessage): void {
    if (!this.queues.has(brainId)) {
      this.queues.set(brainId, []);
    }
    this.queues.get(brainId)!.push(msg);
  }

  private broadcastRaw(msg: BusMessage): void {
    for (const [brainId, queue] of this.queues) {
      if (brainId !== msg.from) {
        queue.push({ ...msg, to: brainId });
      }
    }
  }
}
