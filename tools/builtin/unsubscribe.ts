import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolOutput, BrainJson, CapabilitySelector } from "../../src/core/types.js";

const EMPTY_SUBS: CapabilitySelector = { global: "none", enable: [], disable: [] };

export default {
  name: "unsubscribe",
  description:
    "Disable a subscription source for this brain. Adds the source to the " +
    "subscriptions.disable[] list in brain.json (and removes it from enable[]). " +
    "The change is picked up automatically by the file watcher, which triggers " +
    "reconciliation to stop the source.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the subscription source to disable",
      },
    },
    required: ["name"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const name = String(args.name);

    const brainJsonPath = join(ctx.pathManager.local(ctx.brainId).root(), "brain.json");

    let brainConfig: BrainJson;
    try {
      brainConfig = JSON.parse(await readFile(brainJsonPath, "utf-8"));
    } catch {
      brainConfig = {};
    }

    const subs: CapabilitySelector = brainConfig.subscriptions
      ? { ...EMPTY_SUBS, ...brainConfig.subscriptions }
      : { ...EMPTY_SUBS };

    subs.enable = subs.enable ?? [];
    subs.disable = subs.disable ?? [];

    if (!subs.disable.includes(name)) subs.disable.push(name);
    subs.enable = subs.enable.filter((n) => n !== name);

    brainConfig.subscriptions = subs;
    await writeFile(brainJsonPath, JSON.stringify(brainConfig, null, 2) + "\n", "utf-8");

    return `Unsubscribed from "${name}". The file watcher will trigger reconciliation automatically.`;
  },
} satisfies ToolDefinition;
