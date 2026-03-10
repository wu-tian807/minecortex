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
      tools_path: {
        type: "string",
        description: "(create only) Redirect tools loading to this workspace-relative or absolute directory",
      },
      slots_path: {
        type: "string",
        description: "(create only) Redirect slots loading to this workspace-relative or absolute directory",
      },
      subscriptions_path: {
        type: "string",
        description: "(create only) Redirect subscriptions loading to this workspace-relative or absolute directory",
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
      paths: {
        ...(args.tools_path ? { tools: String(args.tools_path) } : {}),
        ...(args.slots_path ? { slots: String(args.slots_path) } : {}),
        ...(args.subscriptions_path ? { subscriptions: String(args.subscriptions_path) } : {}),
      },
      autoStart: Boolean(args.auto_start),
    } : undefined;

    return await scheduler.controlBrain(action, brainId, opts);
  },
} satisfies ToolDefinition;
