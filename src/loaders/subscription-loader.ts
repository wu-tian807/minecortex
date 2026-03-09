import { relative } from "node:path";
import type {
  CapabilityDescriptor,
  EventSource,
  EventSourceFactory,
  SourceContext,
  CapabilitySelector,
  FSWatcherAPI,
  BrainBoardAPI,
  BrainContextAPI,
  PathManagerAPI,
  Event,
  DynamicSubscriptionAPI,
} from "../core/types.js";
import type { BrainHooksAPI } from "../hooks/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";
import { runWithLogContext } from "../core/logger.js";
import { discover, filterByCapability } from "./scanner.js";

interface SubscriptionEntry {
  source: EventSource;
  name: string;
}

type SubscriptionModule = { default?: EventSourceFactory };

export class SubscriptionLoader extends BaseLoader<SubscriptionModule, SubscriptionEntry> {
  private emitter: ((event: Event) => void) | null = null;
  private brainContext: BrainContextAPI | null = null;

  // ─── DynamicRegistry layer ───

  private dynamicMap = new Map<string, EventSource>();

  readonly dynamic: DynamicSubscriptionAPI = {
    register: (key: string, source: EventSource) => {
      this.dynamicMap.set(key, source);
      if (this.emitter) {
        try {
          runWithLogContext({ brainId: this.logBrainId, turn: 0 }, () => {
            source.start(this.emitter!);
          });
        } catch (err) {
          console.error(`[SubscriptionLoader.dynamic] start failed for "${key}"`, err);
        }
      }
    },
    release: (key: string) => {
      const source = this.dynamicMap.get(key);
      if (source) {
        try { source.stop(); } catch { /* already stopped */ }
        this.dynamicMap.delete(key);
      }
    },
    get: (key: string) => this.dynamicMap.get(key),
    list: () => [...this.dynamicMap.values()],
  };

  setEmitter(emit: (event: Event) => void): void {
    this.emitter = emit;
  }

  setBrainContext(ctx: BrainContextAPI): void {
    this.brainContext = ctx;
  }

  async importFactory(path: string): Promise<SubscriptionModule> {
    return await import(path);
  }

  validateFactory(factory: SubscriptionModule): boolean {
    return typeof factory.default === "function";
  }

  createInstance(
    factory: SubscriptionModule,
    ctx: LoaderContext,
    name: string,
    descriptor: CapabilityDescriptor,
  ): SubscriptionEntry {
    const sourceCtx: SourceContext = {
      brain: this.brainContext!,
      eventConfig: this.resolveConfig(ctx.selector, descriptor),
    };
    const source = factory.default!(sourceCtx);
    return { source: { ...source, name }, name };
  }

  onRegister(name: string, entry: SubscriptionEntry): void {
    if (!this.emitter) return;
    try {
      runWithLogContext({ brainId: this.logBrainId, turn: 0 }, () => {
        entry.source.start(this.emitter!);
      });
    } catch (err) {
      console.error(`[SubscriptionLoader] subscription_error for "${name}"`, err);
      this.emitter({
        source: `subscription:${name}`,
        type: "subscription_error",
        payload: { error: String(err) },
        ts: Date.now(),
        handoff: "silent",
      });
    }
  }

  onUnregister(_name: string, entry: SubscriptionEntry): void {
    try {
      entry.source.stop();
    } catch { /* already stopped */ }
  }

  private lastCtx: LoaderContext | null = null;
  registerWatchPatterns(watcher: FSWatcherAPI): void {
    const handler = (event: import("../core/types.js").FSChangeEvent) => {
      if (!this.lastCtx) return;
      if (!this.matchesConfiguredDir(event.path)) return;
      this.reloadAll()
        .then(() => console.log(`[SubscriptionLoader] refreshed: ${event.path}`))
        .catch(err => console.error(`[SubscriptionLoader] refresh failed: ${event.path}`, err));
    };
    watcher.register(/^subscriptions(?:\/[^/]+)?\/[^/]+\.ts$/, handler);
    watcher.register(/^brains\/[^/]+\/subscriptions(?:\/[^/]+)?\/[^/]+\.ts$/, handler);
  }

  private matchesConfiguredDir(path: string): boolean {
    if (!this.lastCtx) return false;
    return this.lastCtx.capabilitySources.some((source) => {
      const dir = source.dir;
      const prefix = relative(this.lastCtx!.globalDir, dir).replace(/\\/g, "/");
      return prefix.length > 0 && (path === prefix || path.startsWith(`${prefix}/`));
    });
  }

  async load(ctx: LoaderContext): Promise<EventSource[]> {
    this.lastCtx = ctx;
    const descriptors = await discover(ctx.capabilitySources);
    this.clearRegistry();
    await this.loadAll(descriptors, ctx);
    return [...this.registry.values()].map((e) => e.source);
  }

  reconcile(
    oldSelector: CapabilitySelector,
    newSelector: CapabilitySelector,
    allNames: string[],
  ): { toStart: string[]; toStop: string[] } {
    const descriptors = allNames.map((name) => ({ name, exposedName: name, path: name }));
    const oldEnabled = new Set(filterByCapability(descriptors, oldSelector).map((d) => d.exposedName));
    const newEnabled = new Set(filterByCapability(descriptors, newSelector).map((d) => d.exposedName));

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

  private async reloadAll(): Promise<void> {
    if (!this.lastCtx) return;
    const descriptors = await discover(this.lastCtx.capabilitySources);
    this.clearRegistry();
    await this.loadAll(descriptors, this.lastCtx);
  }
}
