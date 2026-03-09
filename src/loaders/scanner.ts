import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CapabilityDescriptor,
  CapabilitySelector,
  CapabilitySource,
} from "../core/types.js";

async function scanSource(source: CapabilitySource): Promise<CapabilityDescriptor[]> {
  const descriptors: CapabilityDescriptor[] = [];
  try {
    const entries = await readdir(source.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        const name = entry.name.replace(/\.ts$/, "");
        descriptors.push({ name, exposedName: name, path: join(source.dir, entry.name) });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const tag = entry.name;
      try {
        const taggedEntries = await readdir(join(source.dir, tag), { withFileTypes: true });
        for (const taggedEntry of taggedEntries) {
          if (!taggedEntry.isFile() || !taggedEntry.name.endsWith(".ts")) continue;
          const name = taggedEntry.name.replace(/\.ts$/, "");
          descriptors.push({ name, tag, exposedName: name, path: join(source.dir, tag, taggedEntry.name) });
        }
      } catch { /* tag directory doesn't exist — skip */ }
    }
  } catch { /* source directory doesn't exist — skip */ }
  return descriptors;
}

function resolveToken(token: string, descriptors: CapabilityDescriptor[]): CapabilityDescriptor[] {
  if (token.startsWith("#")) {
    const tag = token.slice(1);
    return descriptors.filter((d) => d.tag === tag);
  }

  const atIndex = token.lastIndexOf("@");
  if (atIndex > 0) {
    const name = token.slice(0, atIndex);
    const tag = token.slice(atIndex + 1);
    return descriptors.filter((d) => d.name === name && d.tag === tag);
  }

  const matches = descriptors.filter((d) => d.name === token);
  if (matches.length === 1) return matches;
  if (matches.length > 1) {
    console.warn(`[scanner] ambiguous bare capability "${token}", use "name@tag" instead`);
  }
  return [];
}

/** Scans all sources in order (later sources win) and computes exposedName for tag conflicts. */
export async function discover(sources: CapabilitySource[]): Promise<CapabilityDescriptor[]> {
  const preferred = new Map<string, CapabilityDescriptor>();
  for (const source of sources) {
    for (const entry of await scanSource(source)) {
      preferred.set(`${entry.tag ?? ""}:${entry.name}`, entry);
    }
  }

  const descriptors = [...preferred.values()];
  const nameCount = new Map<string, number>();
  for (const d of descriptors) nameCount.set(d.name, (nameCount.get(d.name) ?? 0) + 1);
  for (const d of descriptors) {
    d.exposedName = (nameCount.get(d.name) ?? 1) > 1 ? `${d.name}@${d.tag ?? "default"}` : d.name;
  }
  return descriptors;
}

/** Filters descriptors by a CapabilitySelector (global/enable/disable/tag tokens). */
export function filterByCapability(
  descriptors: CapabilityDescriptor[],
  selector: CapabilitySelector,
): CapabilityDescriptor[] {
  const selected = new Map<string, CapabilityDescriptor>();

  if (selector.global === "all") {
    for (const d of descriptors) selected.set(d.exposedName, d);
  } else {
    for (const token of selector.enable ?? []) {
      for (const d of resolveToken(token, descriptors)) selected.set(d.exposedName, d);
    }
  }

  for (const token of selector.disable ?? []) {
    for (const d of resolveToken(token, descriptors)) selected.delete(d.exposedName);
  }

  return [...selected.values()];
}
