/** @desc NoticeQueue — per-brain 纯内容累积器，与触发逻辑完全分离 */

import type { Notice, NoticeQueueInterface } from "./types.js";

const MAX_NOTICES = 50;

export class NoticeQueue implements NoticeQueueInterface {
  private queue: Notice[] = [];

  push(notice: Notice): void {
    this.queue.push(notice);
    if (this.queue.length > MAX_NOTICES) {
      this.queue.shift();
    }
  }

  drain(): Notice[] {
    if (this.queue.length === 0) return [];
    const batch = [...this.queue];
    this.queue.length = 0;
    return batch;
  }

  pending(): number {
    return this.queue.length;
  }
}
