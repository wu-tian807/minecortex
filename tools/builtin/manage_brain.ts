import type { ToolDefinition, ToolOutput } from "../../src/core/types.js";
import { getScheduler } from "../../src/core/scheduler.js";

export default {
  name: "manage_brain",
  description:
    "Unified brain lifecycle management. " +
    "list = show active brains, create = new brain dir with config, " +
    "start = launch existing brain, stop = pause (keep context), " +
    "shutdown = stop + clear runtime, restart = shutdown + reinit, " +
    "free = shutdown + delete BrainBoard + delete brain dir.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "create", "start", "stop", "restart", "shutdown", "free"],
        description: "Action to perform",
      },
      brain_id: {
        type: "string",
        description: "Target brain ID (required for all actions except list)",
      },
      model: {
        type: "string",
        description: "(create only) Model override for brain.json",
      },
      soul: {
        type: "string",
        description: "(create only) Custom soul.md content",
      },
      subscriptions: {
        type: "object",
        description: "(create only) Custom subscriptions selector",
      },
      auto_start: {
        type: "boolean",
        description: "(create only) Start the brain immediately after creation",
      },
    },
    required: ["action"],
  },
  async execute(args, _ctx): Promise<ToolOutput> {
    const action = String(args.action);
    const brainId = args.brain_id ? String(args.brain_id) : undefined;

    const scheduler = getScheduler();
    if (!scheduler) return "Scheduler not running.";

    if (action !== "list" && !brainId) {
      return `brain_id is required for action '${action}'`;
    }

    const opts = action === "create" ? {
      model: args.model ? String(args.model) : undefined,
      soul: args.soul ? String(args.soul) : undefined,
      subscriptions: args.subscriptions as Record<string, unknown> | undefined,
      autoStart: Boolean(args.auto_start),
    } : undefined;

    return await scheduler.controlBrain(action, brainId, opts);
  },
} satisfies ToolDefinition;
