import { join } from "node:path";
import type { ContextSlot, SlotFactory, SlotContext } from "../context/types.js";
import type { FSWatcherAPI, FSChangeEvent } from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";

type SlotModule = { default: SlotFactory };

export class SlotLoader extends BaseLoader<SlotModule, ContextSlot[]> {
  private slotCtx: SlotContext | null = null;
  private onSlotChange: ((slots: ContextSlot[]) => void) | null = null;
  private onSlotRemove: ((names: string[]) => void) | null = null;

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
    const name = event.path.replace(/.*\//, "").replace(/\.ts$/, "");
    if (event.type === "delete") {
      const existing = this.registry.get(name);
      if (existing) {
        this.onUnregister(name, existing);
        this.registry.delete(name);
      }
    } else {
      this.invalidateSlot(name);
    }
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
    const paths = await this.discover(
      join(ctx.globalDir, "slots"),
      join(ctx.brainDir, "slots"),
    );
    await this.loadAll(paths, ctx);
    return [...this.registry.values()].flat();
  }
}
