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
import type { BrainHooksAPI } from "../hooks/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

interface SubscriptionEntry {
  source: EventSource;
  name: string;
}

export class SubscriptionLoader extends BaseLoader<EventSourceFactory, SubscriptionEntry> {
  private emitter: ((event: Event) => void) | null = null;
  private brainBoard: BrainBoardAPI | null = null;
  private hooks: BrainHooksAPI | null = null;
  private commandHandler: ((toolName: string, args: Record<string, string>, target?: string, reason?: string) => void) | null = null;

  setEmitter(emit: (event: Event) => void): void {
    this.emitter = emit;
  }

  setBrainBoard(board: BrainBoardAPI): void {
    this.brainBoard = board;
  }

  setHooks(hooks: BrainHooksAPI): void {
    this.hooks = hooks;
  }

  setCommandHandler(handler: (toolName: string, args: Record<string, string>, target?: string, reason?: string) => void): void {
    this.commandHandler = handler;
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
      hooks: this.hooks!,
      onCommand: this.commandHandler
        ? (toolName, args, target, reason) => this.commandHandler!(toolName, args, target, reason)
        : undefined,
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

  private lastCtx: LoaderContext | null = null;
  private pathMap = new Map<string, string>();

  registerWatchPatterns(watcher: FSWatcherAPI): void {
    const self = this;
    const handler = (event: import("../core/types.js").FSChangeEvent) => {
      if (!self.lastCtx) return;
      const name = event.path.replace(/\.ts$/, "").split("/").pop() ?? "";
      const fullPath = self.pathMap.get(name);
      if (fullPath) {
        self.reload(name, fullPath, self.lastCtx)
          .then(entry => { if (entry) console.log(`[SubscriptionLoader] hot-reloaded: ${name}`); })
          .catch(err => console.error(`[SubscriptionLoader] hot-reload failed: ${name}`, err));
      }
    };
    watcher.register(/subscriptions\/[^/]+\.ts$/, handler);
    watcher.register(/brains\/[^/]+\/subscriptions\/[^/]+\.ts$/, handler);
    watcher.register(/brains\/[^/]+\/brain\.json$/, () => {});
  }

  async load(ctx: LoaderContext): Promise<EventSource[]> {
    this.lastCtx = ctx;
    const paths = await this.discover(
      join(ctx.globalDir, "subscriptions"),
      join(ctx.brainDir, "subscriptions"),
    );
    this.pathMap = paths;
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
