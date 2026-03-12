import type { DynamicSlotAPI } from "../core/types.js";
import type { ContextSlot } from "../context/types.js";
import type { SlotRegistryView } from "./types.js";

export class SlotRegistry implements DynamicSlotAPI, SlotRegistryView {
  // staticSlots  — managed exclusively by SlotLoader (file discovery / hot-reload)
  // dynamicSlots — managed exclusively by tools via ctx.slot (DynamicSlotAPI)
  private staticSlots = new Map<string, ContextSlot>();
  private dynamicSlots = new Map<string, ContextSlot>();

  registerStatic(slot: ContextSlot): void {
    this.staticSlots.set(slot.id, slot);
  }

  releaseStatic(id: string): void {
    this.staticSlots.delete(id);
  }

  getStatic(id: string): ContextSlot | undefined {
    return this.staticSlots.get(id);
  }

  all(): ContextSlot[] {
    return [...this.staticSlots.values(), ...this.dynamicSlots.values()];
  }

  register(id: string, content: string): void {
    this.dynamicSlots.set(id, {
      id,
      order: 100,
      priority: 3,
      content,
      version: 0,
    });
  }

  update(id: string, content: string): void {
    const slot = this.dynamicSlots.get(id);
    if (slot) {
      slot.content = content;
      slot.version++;
    }
  }

  release(id: string): void {
    this.dynamicSlots.delete(id);
  }

  get(id: string): string | undefined {
    const slot = this.dynamicSlots.get(id);
    if (!slot) return undefined;
    return typeof slot.content === "function" ? slot.content() : slot.content;
  }

  list(): string[] {
    return [...this.dynamicSlots.values()].map((slot) =>
      typeof slot.content === "function" ? slot.content() : slot.content,
    ).filter((content): content is string => typeof content === "string");
  }

  clear(): void {
    this.staticSlots.clear();
    this.dynamicSlots.clear();
  }
}
