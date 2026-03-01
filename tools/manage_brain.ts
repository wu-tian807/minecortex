import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

export default {
  name: "manage_brain",
  description:
    "Manage brain lifecycle: list active brains, or start/stop/restart a specific brain. " +
    "Uses the BrainBoard to read brain status and emits control events to the scheduler.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "start", "stop", "restart"],
        description: "Action to perform",
      },
      brain_id: {
        type: "string",
        description: "Target brain ID (required for start/stop/restart)",
      },
    },
    required: ["action"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const action = String(args.action);
    const brainId = args.brain_id ? String(args.brain_id) : undefined;

    switch (action) {
      case "list": {
        const allBrains = ctx.brainBoard.getAll("__scheduler");
        const brainList = Object.entries(allBrains)
          .filter(([k]) => k.startsWith("brain:"))
          .map(([k, v]) => {
            const id = k.slice(6);
            const status = (v as any)?.status ?? "unknown";
            return `  ${id}: ${status}`;
          });
        if (brainList.length === 0) {
          return "No brains registered in BrainBoard. The scheduler may not have published status yet.";
        }
        return "Active brains:\n" + brainList.join("\n");
      }

      case "start":
      case "stop":
      case "restart": {
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
        return `Unknown action: ${action}. Use list/start/stop/restart.`;
    }
  },
} satisfies ToolDefinition;
