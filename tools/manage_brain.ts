import type { ToolDefinition, ToolOutput } from "../src/core/types.js";
import { getScheduler } from "../src/core/scheduler.js";

export default {
  name: "manage_brain",
  description:
    "Manage brain lifecycle: list active brains, or start/stop/restart/free a specific brain. " +
    "stop = pause (keep context), shutdown = stop + clear runtime, restart = shutdown + reinit, free = shutdown + delete BrainBoard entries.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "start", "stop", "restart", "shutdown", "free"],
        description: "Action to perform",
      },
      brain_id: {
        type: "string",
        description: "Target brain ID (required for start/stop/restart/shutdown/free)",
      },
    },
    required: ["action"],
  },
  async execute(args, _ctx): Promise<ToolOutput> {
    const action = String(args.action);
    const brainId = args.brain_id ? String(args.brain_id) : undefined;

    const scheduler = getScheduler();
    if (!scheduler) return "Scheduler not running.";

    if (action === "list") {
      const ids = scheduler.listBrains();
      if (ids.length === 0) return "No active brains.";
      return "Active brains:\n" + ids.map(id => `  - ${id}`).join("\n");
    }

    if (!brainId) return `brain_id is required for action '${action}'`;
    return await scheduler.controlBrain(action, brainId);
  },
} satisfies ToolDefinition;
