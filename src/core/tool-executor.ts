/** @desc Standalone tool dispatch function, extracted from brain.ts agent loop */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getLogContext, type Logger } from "./logger.js";

/** Execute a tool by name. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tools: ToolDefinition[],
  ctx: ToolContext,
  logger?: Logger,
): Promise<unknown> {
  const tool = tools.find(t => t.name === name);
  if (!tool) return { error: `Unknown tool: ${name}` };
  const { turn } = getLogContext();

  logger?.debug(ctx.brainId, turn, `tool:${name}(${JSON.stringify(args).slice(0, 120)})`);

  try {
    const result = await tool.execute(args, ctx);
    const preview = typeof result === "string"
      ? result.slice(0, 200)
      : JSON.stringify(result).slice(0, 200);
    logger?.debug(ctx.brainId, turn, `tool:${name} → ${preview}`);
    return result;
  } catch (err: any) {
    logger?.error(ctx.brainId, turn, `tool:${name} failed`, err);
    return { error: err.message };
  }
}
