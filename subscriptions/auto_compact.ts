/** @desc Auto-compaction subscription — watches currentContextUsage, triggers compact */

import type { EventSource, SubscriptionContext } from "../src/core/types.js";
import { getModelSpec } from "../src/llm/provider.js";

export default function create(ctx: SubscriptionContext): EventSource {
  const config = ctx.getBrainJson().subscriptions?.config?.auto_compact;
  const threshold = (config?.threshold as number) ?? 1.0;
  let unwatch: (() => void) | null = null;
  let compacting = false;

  return {
    name: "auto_compact",

    start() {
      unwatch = ctx.brainBoard.watch(ctx.brainId, "currentContextUsage", (value) => {
        const totalTokens = value as number;
        if (!totalTokens || totalTokens <= 0 || compacting) return;

        let modelName: string | undefined;
        try {
          const brainJson = ctx.getBrainJson();
          const configuredModel = brainJson.models?.model;
          modelName = Array.isArray(configuredModel) ? configuredModel[0] : configuredModel;
        } catch { return; }
        if (!modelName) return;

        const contextWindow = getModelSpec(modelName).contextWindow;
        if (!contextWindow || contextWindow <= 0) return;

        const utilization = totalTokens / contextWindow;
        if (utilization > threshold) {
          compacting = true;
          const reason = `Context at ${(utilization * 100).toFixed(1)}% (${totalTokens}/${contextWindow}), auto-compacting.`;
          ctx.queueCommand?.("compact", {}, reason);
          setTimeout(() => { compacting = false; }, 5000);
        }
      });
    },

    stop() {
      unwatch?.();
      unwatch = null;
    },
  };
}
