/** @desc Auto-compaction subscription — watches token utilization and emits steer when threshold exceeded */

import type { Event, EventSource, SourceContext } from "../src/core/types.js";

export default function create(ctx: SourceContext): EventSource {
  const threshold = (ctx.config?.threshold as number) ?? 0.6;
  let unwatch: (() => void) | null = null;

  return {
    name: "auto_compact",

    start(emit: (event: Event) => void) {
      unwatch = ctx.brainBoard.watch(ctx.brainId, "tokens.lastInputTokens", (value) => {
        const inputTokens = value as number;
        if (!inputTokens || inputTokens <= 0) return;

        const contextWindow = ctx.brainBoard.get(ctx.brainId, "model.contextWindow") as number;
        if (!contextWindow || contextWindow <= 0) return;

        const utilization = inputTokens / contextWindow;
        if (utilization > threshold) {
          console.log(
            `[auto_compact] 利用率 ${(utilization * 100).toFixed(1)}% 超过阈值 ${(threshold * 100).toFixed(0)}%，请求压缩`,
          );
          emit({
            source: "auto_compact",
            type: "steer",
            payload: {
              text: `Context utilization at ${(utilization * 100).toFixed(1)}% (${inputTokens}/${contextWindow} tokens). Please run the compact tool to free up context space.`,
              utilization,
              inputTokens,
              contextWindow,
            },
            ts: Date.now(),
            steer: true,
            priority: 0,
          });
        }
      });
      console.log(`[auto_compact] 订阅已启动 (阈值 ${(threshold * 100).toFixed(0)}%)`);
    },

    stop() {
      unwatch?.();
      unwatch = null;
    },
  };
}
