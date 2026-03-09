import type { CapabilityDescriptor, CapabilitySelector, FSWatcherAPI } from "../core/types.js";
import { runWithLogContext } from "../core/logger.js";
import { filterByCapability } from "./scanner.js";
import type { LoaderContext } from "./types.js";

export abstract class BaseLoader<TFactory, TInstance> {
  protected registry = new Map<string, TInstance>();
  protected logBrainId = "scheduler";

  abstract importFactory(path: string): Promise<TFactory>;
  abstract validateFactory(factory: TFactory): boolean;
  abstract createInstance(factory: TFactory, ctx: LoaderContext, name: string, descriptor: CapabilityDescriptor): TInstance;
  abstract onRegister(name: string, instance: TInstance): void;
  abstract onUnregister(name: string, instance: TInstance): void;
  abstract registerWatchPatterns(watcher: FSWatcherAPI): void;

  setLogContext(brainId = "scheduler"): void {
    this.logBrainId = brainId;
  }

  async loadAll(
    descriptors: CapabilityDescriptor[],
    ctx: LoaderContext,
  ): Promise<Map<string, TInstance>> {
    for (const descriptor of filterByCapability(descriptors, ctx.selector)) {
      try {
        await runWithLogContext({ brainId: this.logBrainId, turn: 0 }, async () => {
          const factory = await this.importFactory(`${descriptor.path}?t=${Date.now()}`);
          if (!this.validateFactory(factory)) return;
          const instance = this.createInstance(factory, ctx, descriptor.exposedName, descriptor);
          this.registry.set(descriptor.exposedName, instance);
          this.onRegister(descriptor.exposedName, instance);
        });
      } catch (err) {
        console.error(`[BaseLoader] failed to load "${descriptor.exposedName}"`, err);
      }
    }
    return this.registry;
  }

  async reload(
    name: string,
    path: string,
    ctx: LoaderContext,
    descriptor?: CapabilityDescriptor,
  ): Promise<TInstance | undefined> {
    const old = this.registry.get(name);
    if (old) {
      this.onUnregister(name, old);
      this.registry.delete(name);
    }
    try {
      return await runWithLogContext({ brainId: this.logBrainId, turn: 0 }, async () => {
        const factory = await this.importFactory(`${path}?t=${Date.now()}`);
        if (!this.validateFactory(factory)) return undefined;
        const instance = this.createInstance(
          factory, ctx, name,
          descriptor ?? { name, exposedName: name, path },
        );
        this.registry.set(name, instance);
        this.onRegister(name, instance);
        return instance;
      });
    } catch (err) {
      console.error(`[BaseLoader] failed to reload "${name}"`, err);
      return undefined;
    }
  }

  get(name: string): TInstance | undefined {
    return this.registry.get(name);
  }

  getAll(): Map<string, TInstance> {
    return this.registry;
  }

  protected clearRegistry(): void {
    for (const [name, instance] of this.registry) this.onUnregister(name, instance);
    this.registry.clear();
  }

  protected resolveConfig(
    selector: CapabilitySelector,
    descriptor: CapabilityDescriptor,
  ): Record<string, unknown> | undefined {
    return selector.config?.[descriptor.exposedName] ?? selector.config?.[descriptor.name];
  }
}
