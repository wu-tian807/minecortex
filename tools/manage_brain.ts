import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

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
  async execute(args, ctx): Promise<ToolOutput> {
    const action = String(args.action);
    const brainId = args.brain_id ? String(args.brain_id) : undefined;

    switch (action) {
      case "list": {
        const ids = ctx.brainBoard.brainIds();
        if (ids.length === 0) return "No brains found in BrainBoard.";
        const lines = ids.map(id => {
          const entries = ctx.brainBoard.getAll(id);
          const summary = Object.keys(entries).join(", ");
          return `  ${id}: {${summary}}`;
        });
        return "Brains:\n" + lines.join("\n");
      }

      case "start":
      case "stop":
      case "shutdown":
      case "restart":
      case "free": {
        if (!brainId) return `brain_id is required for action '${action}'`;
        ctx.emit({
          source: `brain:${ctx.brainId}`,
          type: "brain_control",
          payload: { action, target: brainId },
          ts: Date.now(),
          priority: 0,
        });
        return `Sent '${action}' request for brain '${brainId}' to scheduler`;
      }

      default:
        return `Unknown action: ${action}. Use list/start/stop/shutdown/restart/free.`;
    }
  },
} satisfies ToolDefinition;
