/** @desc 工具: 通过 BrainBus 向其他脑发送自然语言消息 */

import type { ToolDefinition } from "../src/core/types.js";

export default {
  name: "send_message",
  description:
    "Send a natural language message to another brain via BrainBus. " +
    "Messages are delivered to the recipient's next tick. " +
    "Use '*' as target to broadcast to all brains. " +
    "After sending, output a brief confirmation and end your turn — do not wait for a reply.",
  parameters: {
    to: {
      type: "string",
      description: "Target brain ID (e.g. 'responder') or '*' for broadcast",
      required: true,
    },
    content: {
      type: "string",
      description: "Message body in natural language",
      required: true,
    },
    summary: {
      type: "string",
      description: "Brief summary (5-10 words) for logs and inbox preview",
    },
  },
  async execute(args, ctx) {
    const to = String(args.to).trim();
    const content = String(args.content).trim();
    const summary = String(args.summary ?? "").trim() || content.slice(0, 50);

    if (!to || !content) return { error: '"to" and "content" are required' };

    if (to === "*") {
      ctx.brainBus.broadcast(ctx.brainId, content, summary);
      return { ok: true, broadcast: true };
    }

    ctx.brainBus.send({
      from: ctx.brainId,
      to,
      content,
      summary,
      ts: Date.now(),
    });
    return { ok: true, to, summary };
  },
} satisfies ToolDefinition;
