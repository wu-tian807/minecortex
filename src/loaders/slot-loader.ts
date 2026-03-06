import { join, relative } from "node:path";
import type { ContextSlot, SlotFactory, SlotContext } from "../context/types.js";
import type { FSWatcherAPI, FSChangeEvent } from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

type SlotModule = { default: SlotFactory };

export class SlotLoader extends BaseLoader<SlotModule, ContextSlot[]> {
  private slotCtx: SlotContext | null = null;
  private onSlotChange: ((slots: ContextSlot[]) => void) | null = null;
  private onSlotRemove: ((names: string[]) => void) | null = null;
  private loaderCtx: LoaderContext | null = null;
  private slotPaths: Map<string, string> = new Map();

  setSlotContext(ctx: SlotContext): void {
    this.slotCtx = ctx;
  }

  setCallbacks(
    onChange: (slots: ContextSlot[]) => void,
    onRemove: (names: string[]) => void,
  ): void {
    this.onSlotChange = onChange;
    this.onSlotRemove = onRemove;
  }

  async importFactory(path: string): Promise<SlotModule> {
    return await import(path);
  }

  createInstance(factory: SlotModule, ctx: LoaderContext, name: string): ContextSlot[] {
    if (!this.slotCtx) {
      throw new Error(`[SlotLoader] setSlotContext must be called before loading slot "${name}"`);
    }
    const slotCtx: SlotContext = {
      ...this.slotCtx,
      config: ctx.selector.config?.[name] ?? this.slotCtx.config,
    };
    const result = factory.default(slotCtx);
    return Array.isArray(result) ? result : [result];
  }

  onRegister(_name: string, slots: ContextSlot[]): void {
    this.onSlotChange?.(slots);
  }

  onUnregister(_name: string, slots: ContextSlot[]): void {
    this.onSlotRemove?.(slots.map((s) => s.id));
  }

  registerWatchPatterns(watcher: FSWatcherAPI): void {
    watcher.register(/^slots\/[^/]+\.ts$/, (event) => {
      this.handleDirectChange(event);
    });
    watcher.register(/^brains\/[^/]+\/slots\/[^/]+\.ts$/, (event) => {
      this.handleDirectChange(event);
    });

    watcher.register(/^directives\/.*\.md$/, (event) => {
      this.invalidateBrainSlot(event, "directives");
    });
    watcher.register(/^brains\/[^/]+\/directives\/.*\.md$/, (event) => {
      this.invalidateBrainSlot(event, "directives");
    });

    watcher.register(/^skills\/.*\.md$/, (event) => {
      this.invalidateBrainSlot(event, "skills");
    });
    watcher.register(/^brains\/[^/]+\/skills\/.*\.md$/, (event) => {
      this.invalidateBrainSlot(event, "skills");
    });

    watcher.register(/^brains\/[^/]+\/soul\.md$/, (event) => {
      this.invalidateBrainSlot(event, "soul");
    });
  }

  private handleDirectChange(event: FSChangeEvent): void {
    if (!this.matchesConfiguredDir(event.path)) return;
    const name = event.path.replace(/.*\//, "").replace(/\.ts$/, "");
    if (event.type === "delete") {
      const existing = this.registry.get(name);
      if (existing) {
        this.onUnregister(name, existing);
        this.registry.delete(name);
        this.slotPaths.delete(name);
      }
    } else {
      this.reloadSlot(name, event.path);
    }
  }

  private async reloadSlot(name: string, relativePath: string): Promise<void> {
    if (!this.loaderCtx) return;

    const absolutePath = join(this.loaderCtx.globalDir, relativePath);
    this.slotPaths.set(name, absolutePath);

    await this.reload(name, absolutePath, this.loaderCtx);
  }

  private matchesConfiguredDir(path: string): boolean {
    if (!this.loaderCtx) return false;
    const dirs = [
      this.loaderCtx.globalCapabilityDir ?? join(this.loaderCtx.globalDir, "slots"),
      this.loaderCtx.localCapabilityDir ?? join(this.loaderCtx.brainDir, "slots"),
    ];
    return dirs.some((dir) => {
      const prefix = relative(this.loaderCtx!.globalDir, dir).replace(/\\/g, "/");
      return prefix.length > 0 && (path === prefix || path.startsWith(`${prefix}/`));
    });
  }

  invalidateSlot(name: string): void {
    const slots = this.registry.get(name);
    if (slots) {
      this.onSlotRemove?.(slots.map((s) => s.id));
      this.registry.delete(name);
    }
  }

  invalidateBrainSlot(_event: FSChangeEvent, name: string): void {
    this.invalidateSlot(name);
  }

  async load(ctx: LoaderContext): Promise<ContextSlot[]> {
    this.loaderCtx = ctx;
    const paths = await this.discover(
      ctx.globalCapabilityDir ?? join(ctx.globalDir, "slots"),
      ctx.localCapabilityDir ?? join(ctx.brainDir, "slots"),
    );
    this.slotPaths = paths;
    await this.loadAll(paths, ctx);
    return [...this.registry.values()].flat();
  }
}
