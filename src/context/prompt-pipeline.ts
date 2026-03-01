import type { ModelSpec } from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";
import type { ContextSlot } from "./types.js";
import { estimateTokens } from "../core/token-stats.js";

interface ResolvedSlot {
  slot: ContextSlot;
  text: string;
  tokens: number;
}

const NEVER_TRIM_PRIORITY = 9;

function resolveContent(slot: ContextSlot): string {
  return typeof slot.content === "function" ? slot.content() : slot.content;
}

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

// ─── Stage 1: Resolve — evaluate lazy content ───

function resolveSlots(
  slots: ContextSlot[],
  spec?: Pick<ModelSpec, "tokensPerChar">,
): ResolvedSlot[] {
  return slots.map((slot) => {
    const text = resolveContent(slot);
    const tokens = estimateTokens(text, spec);
    return { slot, text, tokens };
  });
}

// ─── Stage 2: Filter — drop slots where condition() is false ───

function filterSlots(resolved: ResolvedSlot[]): ResolvedSlot[] {
  return resolved.filter(
    (r) => !r.slot.condition || r.slot.condition(),
  );
}

// ─── Stage 3: Sort — by order ascending ───

function sortSlots(resolved: ResolvedSlot[]): ResolvedSlot[] {
  return resolved.slice().sort((a, b) => a.slot.order - b.slot.order);
}

// ─── Stage 4: Render — template variable substitution ───

function renderSlots(
  resolved: ResolvedSlot[],
  vars: Record<string, string>,
): ResolvedSlot[] {
  return resolved.map((r) => ({
    ...r,
    text: renderTemplate(r.text, vars),
  }));
}

// ─── Stage 5: Budget — priority-based trimming ───

function budgetSlots(
  resolved: ResolvedSlot[],
  tokenBudget: number,
  spec?: Pick<ModelSpec, "tokensPerChar">,
): ResolvedSlot[] {
  let totalTokens = resolved.reduce((sum, r) => sum + r.tokens, 0);
  if (totalTokens <= tokenBudget) return resolved;

  const byPriority = resolved
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.slot.priority < NEVER_TRIM_PRIORITY)
    .sort((a, b) => a.r.slot.priority - b.r.slot.priority);

  const removed = new Set<number>();

  for (const { r, i } of byPriority) {
    if (totalTokens <= tokenBudget) break;
    totalTokens -= r.tokens;
    removed.add(i);
  }

  return resolved.filter((_, i) => !removed.has(i));
}

// ─── Public API ───

export function assembleSystemPrompt(
  slots: ContextSlot[],
  tokenBudget: number,
  spec?: Pick<ModelSpec, "tokensPerChar">,
  vars: Record<string, string> = {},
): string {
  const system = slots.filter(
    (s) => s.kind === "system" || s.kind === "dynamic",
  );

  let resolved = resolveSlots(system, spec);
  resolved = filterSlots(resolved);
  resolved = sortSlots(resolved);
  resolved = renderSlots(resolved, vars);
  resolved = budgetSlots(resolved, tokenBudget, spec);

  return resolved.map((r) => r.text).filter(Boolean).join("\n\n");
}

export function assembleMessages(slots: ContextSlot[]): LLMMessage[] {
  const message = slots.filter((s) => s.kind === "message");

  let resolved = resolveSlots(message);
  resolved = filterSlots(resolved);
  resolved = sortSlots(resolved);

  return resolved.map((r) => ({
    role: "user" as const,
    content: r.text,
  }));
}
