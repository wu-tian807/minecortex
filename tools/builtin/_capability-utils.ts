/**
 * _capability-utils.ts — Shared helpers for tools that configure brain.json CapabilitySelectors.
 *
 * The three selectors (tools / slots / subscriptions) share an identical schema
 * (CapabilitySelector), so all read/write and merge/overwrite logic lives here.
 *
 * Two mutation modes:
 *   merge     — delta update: enable or disable one named capability, optionally
 *               change the global field.  Preserves every other entry untouched.
 *   overwrite — full replacement: the caller supplies a complete CapabilitySelector
 *               that replaces the existing one for the given kind.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrainJson, CapabilitySelector, PathManagerAPI } from "../../src/core/types.js";

// ─── Types ───

/**
 * Open string type — any key that appears in BrainJson as a CapabilitySelector.
 * The three built-in kinds are listed in BUILTIN_CAPABILITY_KINDS for reference
 * and UI hints, but custom loader kinds are supported without type changes.
 */
export type CapabilityKind = string;

/** Built-in capability kinds shipped with the framework. */
export const BUILTIN_CAPABILITY_KINDS = ["subscriptions", "tools", "slots"] as const;

export interface MergeOpts {
  /** Items to add to enable[] and remove from disable[]. */
  enable?: string[];
  /** Items to add to disable[] and remove from enable[]. */
  disable?: string[];
  /** Update the global (framework) layer default. */
  global?: "all" | "none";
  /** Update the bundle layer default. */
  bundle?: "all" | "none";
  /** Merged into selector.config for each enabled item. */
  config?: Record<string, Record<string, unknown>>;
}

// ─── brain.json I/O ───

export function brainJsonPath(pm: PathManagerAPI, brainId: string): string {
  return join(pm.local(brainId).root(), "brain.json");
}

export async function readBrainJson(path: string): Promise<BrainJson> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as BrainJson;
  } catch {
    return {};
  }
}

export async function writeBrainJson(path: string, config: BrainJson): Promise<void> {
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ─── Selector helpers ───

// Baseline for new/patched selectors.
// global and bundle are both "none"; local layer always loads unconditionally.
const SELECTOR_DEFAULTS: CapabilitySelector = { global: "none", bundle: "none", enable: [], disable: [] };

/** Return a deep copy of `current` with normalised arrays and explicit bundle field. */
function normalise(current: CapabilitySelector): CapabilitySelector {
  return {
    ...SELECTOR_DEFAULTS,
    ...current,
    enable: [...(current.enable ?? [])],
    disable: [...(current.disable ?? [])],
  };
}

/**
 * Merge-mode mutation.
 * Merges enable[]/disable[] lists into the existing selector and optionally
 * updates the global/bundle layer defaults.
 */
export function applyMerge(
  current: CapabilitySelector,
  opts: MergeOpts,
): CapabilitySelector {
  const next = normalise(current);

  if (opts.global !== undefined) next.global = opts.global;
  if (opts.bundle !== undefined) next.bundle = opts.bundle;

  for (const name of opts.enable ?? []) {
    if (!next.enable!.includes(name)) next.enable!.push(name);
    next.disable = next.disable!.filter((n) => n !== name);
  }

  for (const name of opts.disable ?? []) {
    if (!next.disable!.includes(name)) next.disable!.push(name);
    next.enable = next.enable!.filter((n) => n !== name);
  }

  if (opts.config) {
    next.config = { ...(next.config ?? {}), ...opts.config };
  }

  return next;
}

/**
 * Overwrite-mode mutation.
 * Returns a normalised copy of the supplied selector, ignoring whatever was
 * previously stored for that kind.
 */
export function applyOverwrite(selector: CapabilitySelector): CapabilitySelector {
  return normalise(selector);
}

/** Read → mutate → write a single CapabilitySelector inside brain.json. */
export async function patchBrainSelector(
  pm: PathManagerAPI,
  brainId: string,
  kind: CapabilityKind,
  patch: (current: CapabilitySelector) => CapabilitySelector,
): Promise<{ path: string; next: CapabilitySelector }> {
  const path = brainJsonPath(pm, brainId);
  const config = await readBrainJson(path);
  const raw = (config as Record<string, unknown>)[kind];
  const current = (raw as CapabilitySelector | undefined) ?? { ...SELECTOR_DEFAULTS };
  const next = patch(current);
  (config as Record<string, unknown>)[kind] = next;
  await writeBrainJson(path, config);
  return { path, next };
}

// ─── Tool factory ───

/**
 * Returns a ToolDefinition that configures the CapabilitySelector for a specific
 * capability kind (subscriptions / tools / slots / any custom kind).
 *
 * All three configure_*.ts tools are thin wrappers around this factory so the
 * schema and execute logic stay in one place.
 */
export function makeCapabilityTool(opts: {
  name: string;
  kind: CapabilityKind;
  subject: string;   // human-readable label used in descriptions
}): import("../../src/core/types.js").ToolDefinition {
  const { name, kind, subject } = opts;

  const SELECTOR_SCHEMA = {
    type: "object" as const,
    properties: {
      global: { type: "string" as const, enum: ["all", "none"] },
      bundle: { type: "string" as const, enum: ["all", "none"] },
      enable:  { type: "array" as const, items: { type: "string" as const } },
      disable: { type: "array" as const, items: { type: "string" as const } },
      config:  { type: "object" as const },
    },
    required: ["global"] as string[],
  };

  return {
    name,
    description: [
      `Configure ${subject} (brain.json → ${kind} selector).`,
      "",
      "Two modes:",
      "  merge (default) — list merge: supply enable[], disable[], global, bundle",
      "    in any combination. Lists are merged into existing ones (items move",
      "    between enable/disable, never duplicated). global/bundle update their",
      "    respective layer defaults. At least one field must be provided.",
      "",
      "  overwrite — full replacement: supply a complete selector object.",
      "    Required: selector.global ('all'|'none').",
      "    Optional: selector.bundle, selector.enable[], selector.disable[], selector.config.",
      "",
      "Token formats for enable[]/disable[] items:",
      "  recorder        — exact name",
      "  #builtin        — all entries with this tag",
      "  recorder@events — exact name + tag",
      "",
      "Changes are written to brain.json and picked up by the file watcher.",
    ].join("\n"),

    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["merge", "overwrite"],
          description: "Mutation mode. Defaults to 'merge'.",
        },

        // merge-mode fields
        enable: {
          type: "array",
          items: { type: "string" },
          description: "merge: items to add to enable[] (and remove from disable[]).",
        },
        disable: {
          type: "array",
          items: { type: "string" },
          description: "merge: items to add to disable[] (and remove from enable[]).",
        },
        global: {
          type: "string",
          enum: ["all", "none"],
          description: "merge: update the global (framework) layer default.",
        },
        bundle: {
          type: "string",
          enum: ["all", "none"],
          description: "merge: update the bundle layer default.",
        },
        config: {
          type: "object",
          description: "merge: merged into selector.config (per-item config map).",
        },

        // overwrite-mode field
        selector: {
          ...SELECTOR_SCHEMA,
          description: "overwrite: complete CapabilitySelector to store.",
        },
      },
    },

    async execute(args, ctx) {
      const mode = (args.mode as "merge" | "overwrite" | undefined) ?? "merge";

      if (mode === "overwrite") {
        const sel = args.selector as CapabilitySelector | undefined;
        if (!sel || typeof sel.global !== "string") {
          return "Error: overwrite mode requires 'selector' with a 'global' field";
        }
        const { next } = await patchBrainSelector(ctx.pathManager, ctx.brainId, kind, () => applyOverwrite(sel));
        const bundleNote = sel.bundle !== undefined ? `, bundle=${next.bundle}` : "";
        return (
          `Overwrote ${kind}: global=${next.global}${bundleNote}, ` +
          `enable=[${(next.enable ?? []).join(", ")}], ` +
          `disable=[${(next.disable ?? []).join(", ")}]. ` +
          `File watcher will trigger reconciliation.`
        );
      }

      // merge mode
      const enableArg  = args.enable  as string[] | undefined;
      const disableArg = args.disable as string[] | undefined;
      const globalArg  = args.global  as "all" | "none" | undefined;
      const bundleArg  = args.bundle  as "all" | "none" | undefined;
      const configArg  = args.config  as Record<string, Record<string, unknown>> | undefined;

      if (!enableArg?.length && !disableArg?.length && !globalArg && !bundleArg) {
        return "Error: merge mode requires at least one of: enable, disable, global, bundle";
      }

      const { next } = await patchBrainSelector(ctx.pathManager, ctx.brainId, kind, (current) =>
        applyMerge(current, {
          enable: enableArg,
          disable: disableArg,
          global: globalArg,
          bundle: bundleArg,
          config: configArg,
        }),
      );

      const parts: string[] = [];
      if (enableArg?.length)  parts.push(`enabled=[${enableArg.join(", ")}]`);
      if (disableArg?.length) parts.push(`disabled=[${disableArg.join(", ")}]`);
      if (globalArg)          parts.push(`global→${next.global}`);
      if (bundleArg)          parts.push(`bundle→${next.bundle}`);

      return (
        `Updated ${kind} (${parts.join(", ")}). ` +
        `enable=[${(next.enable ?? []).join(", ")}], ` +
        `disable=[${(next.disable ?? []).join(", ")}]. ` +
        `File watcher will trigger reconciliation.`
      );
    },
  };
}
