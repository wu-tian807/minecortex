import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

export default {
  name: "send_message",
  description:
    "Send a natural language message to another brain or to the user. " +
    "Messages are delivered to the recipient's next tick. " +
    "Use '*' to broadcast to all brains, or 'cli' to send directly to the user's terminal. " +
    "After sending, output a brief confirmation and end your turn — do not wait for a reply.",
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Target brain ID (e.g. 'talker'), '*' for broadcast, or 'cli' for the user's terminal",
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
      handoff: {
        type: "string",
        enum: ["silent", "turn", "innerLoop", "steer"],
        description: "When the recipient should notice this event: silent=queue only, turn=next turn, innerLoop=after current inner loop, steer=interrupt current turn",
      },
    },
    required: ["to", "content"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const to = String(args.to).trim();
    const content = String(args.content).trim();
    const summary = String(args.summary ?? "").trim() || content.slice(0, 50);
    const priority = Number(args.priority ?? 1);
    const handoff = args.handoff == null ? "turn" : String(args.handoff).trim();

    if (!to || !content) return '"to" and "content" are required';
    if (!["silent", "turn", "innerLoop", "steer"].includes(handoff)) {
      return `"handoff" must be one of: silent, turn, innerLoop, steer`;
    }

    ctx.eventBus.emit({
      source: `brain:${ctx.brainId}`,
      type: "message",
      to,
      payload: { content, summary },
      ts: Date.now(),
      priority,
      handoff: handoff as "silent" | "turn" | "innerLoop" | "steer",
    });

    return `Message sent to '${to}': ${summary}`;
  },
} satisfies ToolDefinition;
