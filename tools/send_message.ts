/** @desc 工具: 向其他脑发送自然语言消息，通过统一 Event 路由 */

import type { ToolDefinition } from "../src/core/types.js";

export default {
  name: "send_message",
  description:
    "Send a natural language message to another brain. " +
    "Messages are delivered to the recipient's next tick. " +
    "Use '*' as target to broadcast to all brains. " +
    "After sending, output a brief confirmation and end your turn — do not wait for a reply.",
  parameters: {
    to: {
      type: "string",
      description: "Target brain ID (e.g. 'creative') or '*' for broadcast",
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

    ctx.emit({
      source: `brain:${ctx.brainId}`,
      type: "message",
      payload: { to, content, summary },
      ts: Date.now(),
      priority: 0,
    });

    return { ok: true, to, summary };
  },
} satisfies ToolDefinition;
