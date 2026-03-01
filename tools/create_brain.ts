import type { ToolDefinition, ToolOutput } from "../src/core/types.js";
import { getScheduler } from "../src/core/scheduler.js";

export default {
  name: "create_brain",
  description:
    "Create a new brain directory under brains/<id>/ with brain.json and soul.md. " +
    "Fails if the brain directory already exists.",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Unique brain identifier (used as directory name)",
      },
      model: {
        type: "string",
        description: "Model override for brain.json",
      },
      soul: {
        type: "string",
        description: "Custom soul.md content. Uses default template if omitted.",
      },
      subscriptions: {
        type: "object",
        description: "Custom subscriptions selector for brain.json",
      },
      auto_start: {
        type: "boolean",
        description: "Start the brain immediately after creation (default false)",
      },
    },
    required: ["id"],
  },
  async execute(args, _ctx): Promise<ToolOutput> {
    const scheduler = getScheduler();
    if (!scheduler) return "Scheduler not running.";

    const result = await scheduler.createBrain(String(args.id), {
      model: args.model ? String(args.model) : undefined,
      soul: args.soul ? String(args.soul) : undefined,
      subscriptions: args.subscriptions as Record<string, unknown> | undefined,
      autoStart: Boolean(args.auto_start),
    });

    if (!result.ok) return `Error: ${result.error}`;
    return JSON.stringify(result);
  },
} satisfies ToolDefinition;
