/** @desc Heartbeat subscription — brainboard-tracked timer as EventSource */

import type { Event, EventSource, SubscriptionContext } from "../src/core/types.js";

const BRAINBOARD_KEY = "lastHeartbeatTime";
/** Poll interval for checking whether it's time to fire. */
const POLL_INTERVAL_MS = 10_000;

export default function create(ctx: SubscriptionContext): EventSource {
  const config = ctx.getBrainJson().subscriptions?.config?.heartbeat;
  const intervalMs = (config?.intervalMs as number) ?? 60_000;
  const prompt = (config?.prompt as string) ?? "";
  const brainId = ctx.brainId;
  const board = ctx.brainBoard;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleNext(emit: (event: Event) => void): void {
    if (stopped) return;

    const last = board.get(brainId, BRAINBOARD_KEY) as number | undefined;
    const now = Date.now();
    const elapsed = last !== undefined ? now - last : Infinity;

    if (elapsed >= intervalMs) {
      board.set(brainId, BRAINBOARD_KEY, now);
      emit({
        source: "heartbeat",
        type: "tick",
        payload: { content: prompt },
        ts: now,
        priority: 2,
      });
      timer = setTimeout(() => scheduleNext(emit), intervalMs);
    } else {
      // Wait only the remaining time before the next heartbeat is due
      const remaining = intervalMs - elapsed;
      timer = setTimeout(() => scheduleNext(emit), Math.min(remaining, POLL_INTERVAL_MS));
    }
  }

  return {
    name: "heartbeat",

    start(emit: (event: Event) => void) {
      stopped = false;
      scheduleNext(emit);
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
