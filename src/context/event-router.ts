import type { Event } from "../core/types.js";

export function renderEventDisplay(event: Event): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.content === "string") {
    const summary = (payload as any).summary;
    return summary ? `${summary}: ${payload.content}` : payload.content;
  }
  return JSON.stringify(event.payload);
}
