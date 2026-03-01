import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { CapabilitySelector, FSWatcherAPI } from "../core/types.js";
import type { LoaderContext } from "./types.js";

export abstract class BaseLoader<TFactory, TInstance> {
  protected registry = new Map<string, TInstance>();

  abstract importFactory(path: string): Promise<TFactory>;
  abstract createInstance(factory: TFactory, ctx: LoaderContext, name: string): TInstance;
  abstract onRegister(name: string, instance: TInstance): void;
  abstract onUnregister(name: string, instance: TInstance): void;
  abstract registerWatchPatterns(watcher: FSWatcherAPI): void;

  async discover(globalDir: string, localDir: string): Promise<Map<string, string>> {
    const paths = new Map<string, string>();

    for (const dir of [globalDir, localDir]) {
      try {
        const files = await readdir(dir);
        for (const f of files) {
          if (!f.endsWith(".ts")) continue;
          const name = f.replace(/\.ts$/, "");
          paths.set(name, join(dir, f));
        }
      } catch {
        // directory doesn't exist — skip
      }
    }
    return paths;
  }

  filterByCapability(names: string[], selector: CapabilitySelector): string[] {
    if (selector.global === "all") {
      const disabled = new Set(selector.disable ?? []);
      return names.filter((n) => !disabled.has(n));
    }
    return (selector.enable ?? []).filter((n) => names.includes(n));
  }

  async loadAll(
    paths: Map<string, string>,
    ctx: LoaderContext,
  ): Promise<Map<string, TInstance>> {
    const enabled = this.filterByCapability([...paths.keys()], ctx.selector);

    for (const name of enabled) {
      const filePath = paths.get(name);
      if (!filePath) continue;
      try {
        const factory = await this.importFactory(`${filePath}?t=${Date.now()}`);
        const instance = this.createInstance(factory, ctx, name);
        this.registry.set(name, instance);
        this.onRegister(name, instance);
      } catch (err) {
        console.error(`[BaseLoader] failed to load "${name}":`, err);
      }
    }
    return this.registry;
  }

  async reload(
    name: string,
    path: string,
    ctx: LoaderContext,
  ): Promise<TInstance | undefined> {
    const old = this.registry.get(name);
    if (old) {
      this.onUnregister(name, old);
      this.registry.delete(name);
    }

    try {
      const factory = await this.importFactory(`${path}?t=${Date.now()}`);
      const instance = this.createInstance(factory, ctx, name);
      this.registry.set(name, instance);
      this.onRegister(name, instance);
      return instance;
    } catch (err) {
      console.error(`[BaseLoader] failed to reload "${name}":`, err);
      return undefined;
    }
  }

  get(name: string): TInstance | undefined {
    return this.registry.get(name);
  }

  getAll(): Map<string, TInstance> {
    return this.registry;
  }
}
