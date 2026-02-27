/** @desc 脑间消息路由 — Event 统一原语，内部处理点对点和广播路由 */

import type { Event } from "./types.js";

type RouteCallback = (brainId: string, event: Event) => void;

export class BrainBus {
  private brainIds = new Set<string>();
  private routeCallback: RouteCallback | null = null;

  register(brainId: string): void {
    this.brainIds.add(brainId);
  }

  onRoute(cb: RouteCallback): void {
    this.routeCallback = cb;
  }

  /** Route an event to target brain(s) based on payload.to */
  route(event: Event): void {
    const to = (event.payload as any)?.to as string | undefined;
    if (!to || to === "*") {
      const from = event.source.startsWith("brain:") ? event.source.slice(6) : undefined;
      for (const id of this.brainIds) {
        if (id !== from) {
          this.routeCallback?.(id, event);
        }
      }
    } else {
      this.routeCallback?.(to, event);
    }
  }
}
