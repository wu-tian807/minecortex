import type { DynamicSlotAPI } from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";
import type { ContextSlot } from "./types.js";

export class SlotRegistry implements DynamicSlotAPI {
  private slots = new Map<string, ContextSlot>();

  // ─── Loader-level operations ───

  registerSlot(slot: ContextSlot): void {
    this.slots.set(slot.id, slot);
  }

  update(id: string, content: string): void {
    const slot = this.slots.get(id);
    if (slot) {
      slot.content = content;
      slot.version++;
    }
  }

  removeSlot(id: string): void {
    this.slots.delete(id);
  }

  getSlot(id: string): ContextSlot | undefined {
    return this.slots.get(id);
  }

  all(): ContextSlot[] {
    return [...this.slots.values()];
  }

  // ─── Render helpers ───

  renderSystem(): string {
    const systemSlots = [...this.slots.values()]
      .filter((s) => s.kind === "system" || s.kind === "dynamic")
      .filter((s) => !s.condition || s.condition())
      .sort((a, b) => a.order - b.order);

    const parts: string[] = [];
    for (const slot of systemSlots) {
      const text = typeof slot.content === "function" ? slot.content() : slot.content;
      if (text) parts.push(text);
    }
    return parts.join("\n\n");
  }

  renderMessages(): LLMMessage[] {
    const messageSlots = [...this.slots.values()]
      .filter((s) => s.kind === "message")
      .filter((s) => !s.condition || s.condition())
      .sort((a, b) => a.order - b.order);

    return messageSlots.map((slot) => {
      const text = typeof slot.content === "function" ? slot.content() : slot.content;
      return { role: "user" as const, content: text };
    });
  }

  // ─── DynamicSlotAPI (for tools via ToolContext.slot) ───

  register(id: string, content: string): void {
    this.slots.set(id, {
      id,
      kind: "dynamic",
      order: 100,
      priority: 3,
      content,
      version: 0,
    });
  }

  release(id: string): void {
    this.slots.delete(id);
  }

  get(id: string): string | undefined {
    const slot = this.slots.get(id);
    if (!slot) return undefined;
    return typeof slot.content === "function" ? slot.content() : slot.content;
  }

  clear(): void {
    this.slots.clear();
  }
}
