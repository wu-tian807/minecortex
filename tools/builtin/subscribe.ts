import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolOutput, BrainJson, CapabilitySelector } from "../src/core/types.js";

const EMPTY_SUBS: CapabilitySelector = { global: "none", enable: [], disable: [] };

export default {
  name: "subscribe",
  description:
    "Enable a subscription source for this brain. Adds the source to the " +
    "subscriptions.enable[] list in brain.json (and removes it from disable[] " +
    "if present). Optionally provide config that will be stored in " +
    "subscriptions.config[name]. The change is picked up automatically by the " +
    "file watcher, which triggers reconciliation.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the subscription source to enable (e.g. 'heartbeat', 'cli')",
      },
      config: {
        type: "object",
        description: "Optional configuration to pass to the subscription source factory",
      },
    },
    required: ["name"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const name = String(args.name);
    const config = args.config as Record<string, unknown> | undefined;

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

    if (!subs.enable.includes(name)) subs.enable.push(name);
    subs.disable = subs.disable.filter((n) => n !== name);

    if (config) {
      subs.config = subs.config ?? {};
      subs.config[name] = config;
    }

    brainConfig.subscriptions = subs;
    await writeFile(brainJsonPath, JSON.stringify(brainConfig, null, 2) + "\n", "utf-8");

    return `Subscribed to "${name}". The file watcher will trigger reconciliation automatically.`;
  },
} satisfies ToolDefinition;
