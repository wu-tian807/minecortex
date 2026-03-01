/** @desc Stdout subscription — pipes assistant messages to terminal only if brain subscribes to stdin */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event, EventSource, SourceContext, BrainJson } from "../src/core/types.js";
import { HookEvent } from "../src/hooks/types.js";
import { QARecorder } from "../src/session/qa-recorder.js";

function brainHasStdin(ctx: SourceContext): boolean {
  try {
    const raw = readFileSync(join(ctx.brainDir, "brain.json"), "utf-8");
    const config: BrainJson = JSON.parse(raw);
    const sub = config.subscriptions;
    if (!sub) return true;
    if (sub.global === "all") {
      return !(sub.disable ?? []).includes("stdin");
    }
    return (sub.enable ?? []).includes("stdin");
  } catch {
    return true;
  }
}

export default function create(ctx: SourceContext): EventSource {
  let unsubscribe: (() => void) | null = null;
  const qa = new QARecorder(join(ctx.brainDir, "logs"));

  return {
    name: "stdout",

    start(_emit: (event: Event) => void) {
      if (!brainHasStdin(ctx)) return;

      unsubscribe = ctx.hooks.on(HookEvent.AssistantMessage, ({ msg }) => {
        if (!msg.content) return;
        const raw = typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map(p => p.text)
              .join("");
        const text = raw.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();
        if (text) {
          process.stdout.write(text + "\n");
          qa.recordAssistant(text).catch(() => {});
        }
      });
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      qa.close();
    },
  };
}
