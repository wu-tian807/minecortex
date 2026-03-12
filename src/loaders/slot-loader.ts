import { relative } from "node:path";
import type { ContextSlot, SlotFactory, SlotContext } from "../context/types.js";
import type { CapabilityDescriptor, FSWatcherAPI, FSChangeEvent } from "../core/types.js";
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

  // ─── BaseLoader 抽象接口 ───

  async importFactory(path: string): Promise<SlotModule> {
    return await import(path);
  }

  validateFactory(factory: SlotModule): boolean {
    return typeof factory.default === "function";
  }

  createInstance(
    factory: SlotModule,
    _ctx: LoaderContext,
    _name: string,
    descriptor: CapabilityDescriptor,
  ): ContextSlot[] {
    if (!this.slotCtx) {
      throw new Error(`[SlotLoader] setSlotContext must be called before loading slot "${descriptor.exposedName}"`);
    }
    const result = factory.default(this.slotCtx);
    return Array.isArray(result) ? result : [result];
  }

  onRegister(_name: string, slots: ContextSlot[]): void {
    this.onSlotChange?.(slots);
  }

  onUnregister(_name: string, slots: ContextSlot[]): void {
    this.onSlotRemove?.(slots.map((s) => s.id));
  }

  // ─── 扩展 watch：.md 内容文件额外模式 ───

  /**
   * 除 .ts slot 文件（由 super 从 capabilitySources 自动推导）外，
   * 还需 watch directives / skills / soul.md 的变更。
   * soul.md 用 ctx 的 brainId 精确定位；directives / skills 仍按三层 md 文件自定义扫盘。
   */
  protected override registerWatchers(watcher: FSWatcherAPI, ctx: LoaderContext): void {
    super.registerWatchers(watcher, ctx); // .ts slot 文件（全三层自动推导）

    // soul.md：定位到具体 brain 的 local root
    const localRoot = relative(
      ctx.pathManager.root(),
      ctx.pathManager.local(ctx.brainId).root(),
    ).replace(/\\/g, "/");
    const soulEscaped = localRoot.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    watcher.register(
      new RegExp(`^${soulEscaped}/soul\\.md$`),
      (event) => this.invalidateBrainSlot(event, "soul"),
      { ownerId: ctx.brainId },
    );

    watcher.register(/^directives\/[^/]+\.md$/, (e) => this.invalidateBrainSlot(e, "directives"), { ownerId: ctx.brainId });
    watcher.register(/^bundle\/directives\/[^/]+\.md$/, (e) => this.invalidateBrainSlot(e, "directives"), { ownerId: ctx.brainId });
    watcher.register(/^bundle\/brains\/[^/]+\/directives\/[^/]+\.md$/, (e) => this.invalidateBrainSlot(e, "directives"), { ownerId: ctx.brainId });
    watcher.register(/^skills\/[^/]+\.md$/, (e) => this.invalidateBrainSlot(e, "skills"), { ownerId: ctx.brainId });
    watcher.register(/^bundle\/skills\/[^/]+\.md$/, (e) => this.invalidateBrainSlot(e, "skills"), { ownerId: ctx.brainId });
    watcher.register(/^bundle\/brains\/[^/]+\/skills\/[^/]+\.md$/, (e) => this.invalidateBrainSlot(e, "skills"), { ownerId: ctx.brainId });
  }

  // ─── 公共 API ───

  async load(ctx: LoaderContext): Promise<ContextSlot[]> {
    await this._loadInternal(ctx);
    return [...this.registry.values()].flat();
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
}
