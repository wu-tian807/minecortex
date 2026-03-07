/** @desc ScriptBrain — runs user-defined TypeScript scripts */

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { ScriptContext, Event, BrainInitConfig } from "./types.js";
import { BaseBrain } from "./base-brain.js";

interface ScriptModule {
  start?: (ctx: ScriptContext) => void | Promise<void>;
  update: (events: Event[], ctx: ScriptContext) => void | Promise<void>;
}

export class ScriptBrain extends BaseBrain {
  private ctx: ScriptContext;

  constructor(config: BrainInitConfig) {
    super(config);
    this.ctx = {
      brainId: this.id,
      eventBus: this.boundEventBus,
      brainBoard: this.brainBoard,
    };
  }

  protected async runMain(_signal: AbortSignal): Promise<void> {
    const modulePath = pathToFileURL(join(this.brainDir, "src", "index.ts")).href;
    const mod = (await import(modulePath)) as ScriptModule;

    // Start sources
    this.startSources();

    if (mod.start) await mod.start(this.ctx);

    while (!this.signal.aborted) {
      await this.queue.waitForEvent(this.signal);

      if (this.coalesceMs > 0) {
        await new Promise((r) => setTimeout(r, this.coalesceMs));
      }

      const events = this.queue.drain();
      if (events.length > 0) {
        await mod.update(events, this.ctx);
      }
    }
  }
}
