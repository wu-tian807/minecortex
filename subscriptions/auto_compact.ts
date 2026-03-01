/** @desc Auto-compaction subscription — watches currentContextUsage, triggers compact via command channel */

import type { EventSource, SourceContext } from "../src/core/types.js";
import { getModelSpec } from "../src/llm/provider.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export default function create(ctx: SourceContext): EventSource {
  const threshold = (ctx.config?.threshold as number) ?? 0.6;
  let unwatch: (() => void) | null = null;
  let compacting = false;

  return {
    name: "auto_compact",

    start() {
      unwatch = ctx.brainBoard.watch(ctx.brainId, "currentContextUsage", (value) => {
        const totalTokens = value as number;
        if (!totalTokens || totalTokens <= 0 || compacting) return;
        if (!ctx.onCommand) return;

        let modelName: string | undefined;
        try {
          const brainJson = JSON.parse(readFileSync(join(ctx.brainDir, "brain.json"), "utf-8"));
          modelName = brainJson.model;
          if (Array.isArray(modelName)) modelName = modelName[0];
        } catch { return; }
        if (!modelName) return;

        const contextWindow = getModelSpec(modelName).contextWindow;
        if (!contextWindow || contextWindow <= 0) return;

        const utilization = totalTokens / contextWindow;
        if (utilization > threshold) {
          compacting = true;
          const reason = `Context at ${(utilization * 100).toFixed(1)}% (${totalTokens}/${contextWindow}), auto-compacting.`;
          console.log(`[auto_compact] ${reason}`);
          ctx.onCommand("compact", {}, "/", reason);
          setTimeout(() => { compacting = false; }, 5000);
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
