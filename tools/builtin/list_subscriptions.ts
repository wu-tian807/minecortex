import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolOutput, BrainJson, CapabilitySelector } from "../../src/core/types.js";

interface SubEntry {
  name: string;
  status: "active" | "disabled" | "available";
  scope: "global" | "brain";
}

async function scanSourceNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""));
  } catch {
    return [];
  }
}

export default {
  name: "list_subscriptions",
  description:
    "List all available subscription sources and their status for this brain. " +
    "Scans both the global subscriptions/ directory and the brain-local " +
    "brains/<id>/subscriptions/ directory, then cross-references with the " +
    "brain.json configuration to determine each source's status.",
  input_schema: {
    type: "object",
    properties: {},
  },
  async execute(_args, ctx): Promise<ToolOutput> {
    const brainDir = ctx.pathManager.local(ctx.brainId).root();
    const brainJsonPath = join(brainDir, "brain.json");

    let brainConfig: BrainJson;
    try {
      brainConfig = JSON.parse(await readFile(brainJsonPath, "utf-8"));
    } catch {
      brainConfig = {};
    }

    const subs: CapabilitySelector = brainConfig.subscriptions ?? { global: "none" };
    const enableSet = new Set(subs.enable ?? []);
    const disableSet = new Set(subs.disable ?? []);
    const globalDefault = subs.global ?? "none";

    const globalDir = ctx.pathManager.global().subscriptionsDir();
    const brainSubsDir = join(brainDir, "subscriptions");

    const [globalNames, brainNames] = await Promise.all([
      scanSourceNames(globalDir),
      scanSourceNames(brainSubsDir),
    ]);

    const result: SubEntry[] = [];
    const seen = new Set<string>();

    for (const name of globalNames) {
      seen.add(name);
      let status: SubEntry["status"];
      if (enableSet.has(name)) status = "active";
      else if (disableSet.has(name)) status = "disabled";
      else status = globalDefault === "all" ? "active" : "available";
      result.push({ name, status, scope: "global" });
    }

    for (const name of brainNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      let status: SubEntry["status"];
      if (enableSet.has(name)) status = "active";
      else if (disableSet.has(name)) status = "disabled";
      else status = "available";
      result.push({ name, status, scope: "brain" });
    }

    for (const name of enableSet) {
      if (!seen.has(name)) {
        result.push({ name, status: "active", scope: "global" });
      }
    }

    return JSON.stringify({ subscriptions: result }, null, 2);
  },
} satisfies ToolDefinition;
