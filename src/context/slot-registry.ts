import type { DynamicSlotAPI } from "../core/types.js";
import type { ContextSlot } from "./types.js";

export class SlotRegistry implements DynamicSlotAPI {
  // Two separate maps mirror the ToolLoader pattern:
  // staticSlots  — managed exclusively by SlotLoader (file discovery / hot-reload)
  // dynamicSlots — managed exclusively by tools via ctx.slot (DynamicSlotAPI)
  // Neither side can corrupt the other's entries.
  private staticSlots = new Map<string, ContextSlot>();
  private dynamicSlots = new Map<string, ContextSlot>();

  // ─── Static layer (SlotLoader callbacks) ───

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

  // ─── DynamicSlotAPI (for tools via ToolContext.slot) ───

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
    return [...this.dynamicSlots.values()].map((s) =>
      typeof s.content === "function" ? s.content() : s.content,
    ).filter((c): c is string => typeof c === "string");
  }

  clear(): void {
    this.staticSlots.clear();
    this.dynamicSlots.clear();
  }
}
