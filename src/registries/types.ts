import type { ContextSlot } from "../context/types.js";
import type { Event, ToolDefinition } from "../core/types.js";

export interface SlotRegistryView {
  all(): ContextSlot[];
}

export type ToolRegistryChangeHandler = (tools: ToolDefinition[]) => void;
export type SubscriptionEmitter = (event: Event) => void;
