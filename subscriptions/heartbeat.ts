/** @desc Heartbeat subscription source — periodic timer as standard EventSource */

import type { Event, EventSource, SourceContext } from "../src/core/types.js";

export default function create(ctx: SourceContext): EventSource {
  const intervalMs = (ctx.config?.intervalMs as number) ?? 60_000;
  const prompt = (ctx.config?.prompt as string) ?? "";
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    name: "heartbeat",

    start(emit: (event: Event) => void) {
      timer = setInterval(() => {
        emit({
          source: "heartbeat",
          type: "tick",
          payload: { prompt },
          ts: Date.now(),
          priority: 2,
        });
      }, intervalMs);
      console.log(`[heartbeat] 订阅已启动 (间隔 ${intervalMs}ms)`);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
