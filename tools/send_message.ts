import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

export default {
  name: "send_message",
  description:
    "Send a natural language message to another brain. " +
    "Messages are delivered to the recipient's next tick. " +
    "Use '*' as target to broadcast to all brains. " +
    "After sending, output a brief confirmation and end your turn — do not wait for a reply.",
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Target brain ID (e.g. 'creative') or '*' for broadcast",
      },
      content: {
        type: "string",
        description: "Message body in natural language",
      },
      summary: {
        type: "string",
        description: "Brief summary (5-10 words) for logs and inbox preview",
      },
      priority: {
        type: "string",
        enum: ["0", "1", "2"],
        description: "0=immediate, 1=normal (default), 2=low",
      },
      silent: {
        type: "boolean",
        description: "If true, queue only without triggering processing in recipient",
      },
    },
    required: ["to", "content"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const to = String(args.to).trim();
    const content = String(args.content).trim();
    const summary = String(args.summary ?? "").trim() || content.slice(0, 50);
    const priority = Number(args.priority ?? 1);
    const silent = (args.silent as boolean) ?? false;

    if (!to || !content) return '"to" and "content" are required';

    ctx.eventBus.emit({
      source: `brain:${ctx.brainId}`,
      type: "message",
      payload: { to, content, summary },
      ts: Date.now(),
      priority,
      silent,
    });

    return `Message sent to '${to}': ${summary}`;
  },
} satisfies ToolDefinition;
