import type { Event, ModelSpec } from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";
import type { SlotRegistry } from "./slot-registry.js";
import { EventRouter } from "./event-router.js";
import { assembleSystemPrompt, assembleMessages } from "./prompt-pipeline.js";

export class ContextEngine {
  private registry: SlotRegistry;
  private eventRouter = new EventRouter();

  constructor(registry: SlotRegistry) {
    this.registry = registry;
  }

  assemblePrompt(
    events: Event[],
    sessionHistory: LLMMessage[],
    spec?: ModelSpec,
    tokenBudget?: number,
    vars: Record<string, string> = {},
  ): LLMMessage[] {
    const eventSlots = this.eventRouter.routeEvents(events);
    for (const slot of eventSlots) {
      this.registry.registerSlot(slot);
    }

    const budget = tokenBudget ?? spec?.contextWindow ?? 128_000;
    const allSlots = this.registry.all();

    const systemPrompt = assembleSystemPrompt(allSlots, budget, spec, vars);
    const eventMessages = assembleMessages(allSlots);

    // Clean up transient event slots after assembly
    for (const slot of eventSlots) {
      this.registry.removeSlot(slot.id);
    }

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...sessionHistory,
      ...eventMessages,
    ];

    return messages;
  }
}
