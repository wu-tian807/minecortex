import type { ContextSlot } from "./types.js";

interface ResolvedSlot {
  slot: ContextSlot;
  text: string;
}

function resolveContent(slot: ContextSlot): string {
  return typeof slot.content === "function" ? slot.content() : slot.content;
}

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([\w.]+)\}/g, (_, key) => vars[key] ?? "");
}

// ─── Stage 1: Filter + Resolve — check condition before evaluating lazy content ───
// Condition must be checked first; content() may throw if called unconditionally
// (e.g. when it reads from state that is only valid while condition holds).

function resolveSlots(
  slots: ContextSlot[],
): ResolvedSlot[] {
  return slots
    .filter((slot) => !slot.condition || slot.condition())
    .map((slot) => {
      const text = resolveContent(slot);
      return { slot, text };
    });
}

// ─── Stage 2: (no-op — condition already applied in Stage 1) ───

function filterSlots(resolved: ResolvedSlot[]): ResolvedSlot[] {
  return resolved;
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

// ─── Public API ───

export function assembleSystemPrompt(
  slots: ContextSlot[],
  vars: Record<string, string> = {},
): string {
  let resolved = resolveSlots(slots);
  resolved = filterSlots(resolved);
  resolved = sortSlots(resolved);
  resolved = renderSlots(resolved, vars);

  return resolved.map((r) => r.text).filter(Boolean).join("\n\n");
}
