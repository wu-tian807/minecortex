import { relative } from "node:path";
import type { ContextSlot, SlotFactory, SlotContext } from "../context/types.js";
import type { CapabilityDescriptor, FSWatcherAPI, FSChangeEvent } from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";
import { discover } from "./scanner.js";

type SlotModule = { default: SlotFactory };

export class SlotLoader extends BaseLoader<SlotModule, ContextSlot[]> {
  private slotCtx: SlotContext | null = null;
  private onSlotChange: ((slots: ContextSlot[]) => void) | null = null;
  private onSlotRemove: ((names: string[]) => void) | null = null;
  private loaderCtx: LoaderContext | null = null;

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

  validateFactory(factory: SlotModule): boolean {
    return typeof factory.default === "function";
  }

  createInstance(
    factory: SlotModule,
    ctx: LoaderContext,
    _name: string,
    descriptor: CapabilityDescriptor,
  ): ContextSlot[] {
    if (!this.slotCtx) {
      throw new Error(`[SlotLoader] setSlotContext must be called before loading slot "${descriptor.exposedName}"`);
    }
    const slotCtx: SlotContext = {
      ...this.slotCtx,
      config: this.resolveConfig(ctx.selector, descriptor) ?? this.slotCtx.config,
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
    watcher.register(/^slots(?:\/[^/]+)?\/[^/]+\.ts$/, (event) => {
      this.handleDirectChange(event);
    });
    watcher.register(/^brains\/[^/]+\/slots(?:\/[^/]+)?\/[^/]+\.ts$/, (event) => {
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
    this.reloadAll()
      .then(() => console.log(`[SlotLoader] refreshed: ${event.path}`))
      .catch(err => console.error(`[SlotLoader] refresh failed: ${event.path}`, err));
  }

  private matchesConfiguredDir(path: string): boolean {
    if (!this.loaderCtx) return false;
    return this.loaderCtx.capabilitySources.some((source) => {
      const dir = source.dir;
      const prefix = relative(this.loaderCtx!.globalDir, dir).replace(/\\/g, "/");
      return prefix.length > 0 && (path === prefix || path.startsWith(`${prefix}/`));
    });
  }

  invalidateSlot(name: string, reason?: string): void {
    const slots = this.registry.get(name);
    if (slots) {
      this.onSlotRemove?.(slots.map((s) => s.id));
      this.registry.delete(name);
      console.log(reason ? `[SlotLoader] invalidated: ${name} (${reason})` : `[SlotLoader] invalidated: ${name}`);
    }
  }

  invalidateBrainSlot(event: FSChangeEvent, name: string): void {
    this.invalidateSlot(name, event.path);
  }

  async load(ctx: LoaderContext): Promise<ContextSlot[]> {
    this.loaderCtx = ctx;
    const descriptors = await discover(ctx.capabilitySources);
    this.clearRegistry();
    await this.loadAll(descriptors, ctx);
    return [...this.registry.values()].flat();
  }

  private async reloadAll(): Promise<void> {
    if (!this.loaderCtx) return;
    const descriptors = await discover(this.loaderCtx.capabilitySources);
    this.clearRegistry();
    await this.loadAll(descriptors, this.loaderCtx);
  }
}
