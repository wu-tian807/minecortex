import type { ToolDefinition, ToolContext } from "./types.js";
import type { LLMToolCall } from "../llm/types.js";
import type { ToolLifecycleSink } from "../session/tool-lifecycle.js";
import { HookEvent } from "../hooks/types.js";
import { executeTool } from "./tool-executor.js";

export async function runToolBatch(params: {
  toolCalls: LLMToolCall[];
  tools: ToolDefinition[];
  toolCtx: ToolContext;
  lifecycle: ToolLifecycleSink;
  logger?: import("./logger.js").Logger;
  hooks?: import("../hooks/brain-hooks.js").BrainHooks;
  turn: number;
}): Promise<Array<{ toolCall: LLMToolCall; result: unknown; durationMs: number }>> {
  const { toolCalls, tools, toolCtx, lifecycle, logger, hooks, turn } = params;
  if (toolCalls.length === 0) return [];

  await lifecycle.appendToolPendings(toolCalls);

  const runs = toolCalls.map((tc) => {
    hooks?.emit(HookEvent.ToolCall, { name: tc.name, args: tc.arguments, toolCall: tc });
    const startedAt = Date.now();
    const promise = executeTool(tc.name, tc.arguments, tools, toolCtx, logger);
    return { tc, startedAt, promise };
  });

  const committedResults: Array<{ toolCall: LLMToolCall; result: unknown; durationMs: number }> = [];
  for (const run of runs) {
    const result = await run.promise;
    const durationMs = Date.now() - run.startedAt;
    hooks?.emit(HookEvent.ToolResult, { name: run.tc.name, result, durationMs });
    await lifecycle.appendToolResult(run.tc, result);
    logger?.debug(toolCtx.brainId, turn, `tool batch commit: ${run.tc.name} (${durationMs}ms)`);
    committedResults.push({ toolCall: run.tc, result, durationMs });
  }

  return committedResults;
}
