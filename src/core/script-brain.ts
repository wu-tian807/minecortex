import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { BrainInterface, ScriptContext, Event, BrainBoardAPI } from "./types.js";
import type { EventQueue } from "./event-queue.js";

interface ScriptModule {
  start?: (ctx: ScriptContext) => void | Promise<void>;
  update: (events: Event[], ctx: ScriptContext) => void | Promise<void>;
}

export interface ScriptBrainOpts {
  id: string;
  eventQueue: EventQueue;
  coalesceMs: number;
  emit: (event: Event) => void;
  brainBoard: BrainBoardAPI;
  brainDir: string;
}

export class ScriptBrain implements BrainInterface {
  readonly id: string;
  private queue: EventQueue;
  private coalesceMs: number;
  private ctx: ScriptContext;
  private brainDir: string;

  constructor(opts: ScriptBrainOpts) {
    this.id = opts.id;
    this.queue = opts.eventQueue;
    this.coalesceMs = opts.coalesceMs;
    this.brainDir = opts.brainDir;
    this.ctx = {
      brainId: opts.id,
      emit: opts.emit,
      brainBoard: opts.brainBoard,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    const modulePath = pathToFileURL(join(this.brainDir, "src", "index.ts")).href;
    const mod = (await import(modulePath)) as ScriptModule;

    if (mod.start) await mod.start(this.ctx);

    while (!signal.aborted) {
      await this.queue.waitForEvent(signal);

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
