import type { ContextSlot, SlotFactory, SlotContext } from "../context/types.js";
import type { CapabilityDescriptor, FSWatcherAPI } from "../core/types.js";
import type { LoaderContext, SlotWatchFactory, SlotWatchPattern } from "./types.js";
import { BaseLoader } from "./base-loader.js";

type SlotModule = {
  default: SlotFactory;
  watch?: SlotWatchFactory;
};

export class SlotLoader extends BaseLoader<SlotModule, ContextSlot[]> {
  private slotCtx: SlotContext | null = null;
  private onSlotChange: ((slots: ContextSlot[]) => void) | null = null;
  private onSlotRemove: ((names: string[]) => void) | null = null;
  private contentWatcher: FSWatcherAPI | null = null;
  private contentWatcherOwnerId?: string;
  private declarativeWatches = new Map<string, SlotWatchPattern[]>();

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
    ctx: LoaderContext,
    _name: string,
    descriptor: CapabilityDescriptor,
  ): ContextSlot[] {
    if (!this.slotCtx) {
      throw new Error(`[SlotLoader] setSlotContext must be called before loading slot "${descriptor.exposedName}"`);
    }
    this.declarativeWatches.set(
      descriptor.exposedName,
      factory.watch?.(ctx) ?? [],
    );
    const result = factory.default(this.slotCtx);
    return Array.isArray(result) ? result : [result];
  }

  onRegister(_name: string, slots: ContextSlot[]): void {
    this.onSlotChange?.(slots);
  }

  onUnregister(_name: string, slots: ContextSlot[]): void {
    this.onSlotRemove?.(slots.map((s) => s.id));
  }

  override registerWatchPatterns(watcher: FSWatcherAPI, ownerId?: string): void {
    super.registerWatchPatterns(watcher, ownerId);
    this.contentWatcher = watcher;
    this.contentWatcherOwnerId = ownerId;
  }

  // ─── 公共 API ───

  async load(ctx: LoaderContext): Promise<ContextSlot[]> {
    await this._loadInternal(ctx);
    this.refreshDeclarativeWatches();
    return [...this.registry.values()].flat();
  }

  protected override async reloadAll(): Promise<void> {
    await super.reloadAll();
    this.refreshDeclarativeWatches();
  }

  invalidateSlot(name: string, reason?: string): void {
    const slots = this.registry.get(name);
    if (slots) {
      this.onSlotRemove?.(slots.map((s) => s.id));
      this.registry.delete(name);
      console.log(reason ? `[SlotLoader] invalidated: ${name} (${reason})` : `[SlotLoader] invalidated: ${name}`);
    }
  }

  private refreshDeclarativeWatches(): void {
    if (!this.contentWatcher || !this.contentWatcherOwnerId) return;
    const ownerId = `${this.contentWatcherOwnerId}:slot-content`;
    this.contentWatcher.unregisterOwner(ownerId);

    for (const [slotName, patterns] of this.declarativeWatches) {
      if (!this.registry.has(slotName)) continue;
      for (const watch of patterns) {
        this.contentWatcher.register(
          watch.pattern,
          (event) => {
            if (watch.action === "reloadAll") {
              this.reloadAll()
                .then(() => console.log(`[SlotLoader] reloaded: ${slotName} (${event.path})`))
                .catch((err) => console.error(`[SlotLoader] reload failed: ${slotName} (${event.path})`, err));
              return;
            }
            this.invalidateSlot(slotName, event.path);
          },
          { ownerId, debounceMs: watch.debounceMs },
        );
      }
    }
  }
}
