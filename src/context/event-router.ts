import type { Event } from "../core/types.js";
import type { ContextSlot } from "./types.js";

export function renderEventDisplay(event: Event): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload?.prompt && typeof payload.prompt === "string") {
    return payload.prompt;
  }
  if (payload?.content && typeof payload.content === "string") {
    const summary = (payload as any).summary;
    return summary ? `${summary}: ${payload.content}` : String(payload.content);
  }
  return JSON.stringify(event.payload);
}

export class EventRouter {
  routeEvents(events: Event[]): ContextSlot[] {
    if (events.length === 0) return [];

    const grouped = new Map<string, Event[]>();
    for (const e of events) {
      const list = grouped.get(e.source) ?? [];
      list.push(e);
      grouped.set(e.source, list);
    }

    const slots: ContextSlot[] = [];
    let orderBase = 200;

    for (const [source, evts] of grouped) {
      const lines: string[] = [];
      for (const e of evts) {
        lines.push(`[${e.source}:${e.type}] ${renderEventDisplay(e)}`);
      }

      slots.push({
        id: `events:${source}`,
        kind: "message",
        order: orderBase++,
        priority: 3,
        content: lines.join("\n"),
        version: 0,
      });
    }

    return slots;
  }
}
