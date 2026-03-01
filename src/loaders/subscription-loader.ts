import { join } from "node:path";
import type {
  EventSource,
  EventSourceFactory,
  SourceContext,
  CapabilitySelector,
  FSWatcherAPI,
  BrainBoardAPI,
  Event,
} from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

interface SubscriptionEntry {
  source: EventSource;
  name: string;
}

export class SubscriptionLoader extends BaseLoader<EventSourceFactory, SubscriptionEntry> {
  private emitter: ((event: Event) => void) | null = null;
  private brainBoard: BrainBoardAPI | null = null;

  setEmitter(emit: (event: Event) => void): void {
    this.emitter = emit;
  }

  setBrainBoard(board: BrainBoardAPI): void {
    this.brainBoard = board;
  }

  async importFactory(path: string): Promise<EventSourceFactory> {
    const mod = await import(path);
    return mod.default as EventSourceFactory;
  }

  createInstance(factory: EventSourceFactory, ctx: LoaderContext, name: string): SubscriptionEntry {
    const sourceCtx: SourceContext = {
      brainId: ctx.brainId,
      brainDir: ctx.brainDir,
      config: ctx.selector.config?.[name] ?? undefined,
      brainBoard: this.brainBoard!,
    };
    const source = factory(sourceCtx);
    return { source, name: source.name };
  }

  onRegister(name: string, entry: SubscriptionEntry): void {
    if (!this.emitter) return;
    try {
      entry.source.start(this.emitter);
    } catch (err) {
      console.error(`[SubscriptionLoader] subscription_error for "${name}":`, err);
      this.emitter({
        source: `subscription:${name}`,
        type: "subscription_error",
        payload: { error: String(err) },
        ts: Date.now(),
        silent: true,
      });
    }
  }

  onUnregister(_name: string, entry: SubscriptionEntry): void {
    try {
      entry.source.stop();
    } catch { /* already stopped */ }
  }

  registerWatchPatterns(watcher: FSWatcherAPI): void {
    watcher.register(/subscriptions\/[^/]+\.ts$/, () => {});
    watcher.register(/brains\/[^/]+\/subscriptions\/[^/]+\.ts$/, () => {});
    watcher.register(/brains\/[^/]+\/brain\.json$/, () => {});
  }

  async load(ctx: LoaderContext): Promise<EventSource[]> {
    const paths = await this.discover(
      join(ctx.globalDir, "subscriptions"),
      join(ctx.brainDir, "subscriptions"),
    );
    await this.loadAll(paths, ctx);
    return [...this.registry.values()].map((e) => e.source);
  }

  reconcile(
    oldSelector: CapabilitySelector,
    newSelector: CapabilitySelector,
    allNames: string[],
  ): { toStart: string[]; toStop: string[] } {
    const oldEnabled = new Set(this.filterByCapability(allNames, oldSelector));
    const newEnabled = new Set(this.filterByCapability(allNames, newSelector));

    const toStart = [...newEnabled].filter((n) => !oldEnabled.has(n));
    const toStop = [...oldEnabled].filter((n) => !newEnabled.has(n));

    for (const name of toStop) {
      const entry = this.registry.get(name);
      if (entry) {
        this.onUnregister(name, entry);
        this.registry.delete(name);
      }
    }

    return { toStart, toStop };
  }
}
