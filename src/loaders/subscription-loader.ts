import type {
  CapabilityDescriptor,
  EventSource,
  EventSourceFactory,
  SourceContext,
  CapabilitySelector,
  Event,
  BrainContextAPI,
} from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";
import { runWithLogContext } from "../core/logger.js";

interface SubscriptionEntry {
  source: EventSource;
  name: string;
}

type SubscriptionModule = { default?: EventSourceFactory };

export class SubscriptionLoader extends BaseLoader<SubscriptionModule, SubscriptionEntry> {
  private emitter: ((event: Event) => void) | null = null;
  private brainContext: BrainContextAPI | null = null;
  private onSourcesChange: ((sources: EventSource[]) => void) | null = null;

  setEmitter(emit: (event: Event) => void): void {
    this.emitter = emit;
  }

  setBrainContext(ctx: BrainContextAPI): void {
    this.brainContext = ctx;
  }

  setCallback(onChange: (sources: EventSource[]) => void): void {
    this.onSourcesChange = onChange;
  }

  // ─── BaseLoader 抽象接口 ───

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
    if (this.emitter) {
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
    this.notifyChange();
  }

  onUnregister(_name: string, entry: SubscriptionEntry): void {
    try {
      entry.source.stop();
    } catch { /* already stopped */ }
    this.notifyChange();
  }

  // ─── 公共 API ───

  async load(ctx: LoaderContext): Promise<EventSource[]> {
    await this._loadInternal(ctx);
    return this.allStatic();
  }

  /** 按 selector 变更差量启停 subscription，不走完整 reload。 */
  reconcile(
    oldSelector: CapabilitySelector,
    newSelector: CapabilitySelector,
    allNames: string[],
  ): { toStart: string[]; toStop: string[] } {
    const descriptors = allNames.map((name) => ({ name, exposedName: name, path: name }));
    const oldEnabled = new Set(BaseLoader.filterByCapability(descriptors, oldSelector).map((d) => d.exposedName));
    const newEnabled = new Set(BaseLoader.filterByCapability(descriptors, newSelector).map((d) => d.exposedName));

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

  allStatic(): EventSource[] {
    return [...this.registry.values()].map((entry) => entry.source);
  }

  private notifyChange(): void {
    this.onSourcesChange?.(this.allStatic());
  }
}
