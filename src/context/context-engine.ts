import type { ModelSpec } from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";
import type { SlotRegistry } from "./slot-registry.js";
import { assembleSystemPrompt } from "./prompt-pipeline.js";

export class ContextEngine {
  private registry: SlotRegistry;

  constructor(registry: SlotRegistry) {
    this.registry = registry;
  }

  assemblePrompt(
    sessionHistory: LLMMessage[],
    spec?: ModelSpec,
    tokenBudget?: number,
    vars: Record<string, string> = {},
  ): LLMMessage[] {
    const budget = tokenBudget ?? spec?.contextWindow ?? 128_000;
    const allSlots = this.registry.all();
    const systemPrompt = assembleSystemPrompt(allSlots, budget, spec, vars);

    return [
      { role: "system", content: systemPrompt },
      ...sessionHistory,
    ];
  }
}
