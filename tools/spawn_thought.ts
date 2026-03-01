/** @desc spawn_thought — launch sub-agent "thoughts" with recursion limits */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ToolDefinition,
  ToolOutput,
  BrainBoardAPI,
  DynamicSlotAPI,
  PathManagerAPI,
  TerminalManagerAPI,
  Event,
  ModelSpec,
} from "../src/core/types.js";
import type { ThoughtConfig } from "../src/context/types.js";
import type { LLMMessage, LLMProvider } from "../src/llm/types.js";
import { runAgentLoop } from "../src/core/brain.js";
import { ContextEngine } from "../src/context/context-engine.js";
import { SlotRegistry } from "../src/context/slot-registry.js";
import { createProvider, getModelSpec } from "../src/llm/provider.js";

type ThoughtType = "observe" | "plan" | "act";

const THOUGHT_DEFAULTS: Record<ThoughtType, ThoughtConfig> = {
  observe: {
    readOnly: true,
    tools: ["read_file", "glob", "grep", "shell", "list_dir"],
    model: undefined,
    maxIterations: 10,
  },
  plan: {
    readOnly: true,
    tools: ["read_file", "glob", "grep", "shell", "list_dir"],
    model: undefined,
    maxIterations: 5,
  },
  act: {
    readOnly: false,
    tools: [],
    model: undefined,
    maxIterations: 20,
  },
};

const RECURSION_RULES: Record<ThoughtType, ThoughtType[]> = {
  observe: [],
  plan: ["observe"],
  act: ["observe"],
};

function generateThoughtId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `thought_${Date.now()}_${rand}`;
}

export default {
  name: "spawn_thought",
  description:
    "Spawn a sub-agent thought to perform a focused task. " +
    "Types: observe (read-only exploration), plan (read-only planning), act (can modify). " +
    "Background mode returns immediately; foreground mode awaits result.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task for the sub-agent to perform",
      },
      type: {
        type: "string",
        enum: ["observe", "plan", "act"],
        description: "Thought type: observe (read-only, fast), plan (read-only), act (full tools)",
      },
      model: {
        type: "string",
        description: "Override model for this thought (default: inherit or fast for observe)",
      },
      mode: {
        type: "string",
        enum: ["background", "foreground"],
        description: "background: return immediately; foreground: await result (default: background)",
      },
      context: {
        type: "string",
        enum: ["none", "summary", "full"],
        description: "How much parent context to pass (default: none)",
      },
      todoId: {
        type: "string",
        description: "Optional: associate this thought with a todo item for tracking",
      },
    },
    required: ["task", "type"],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const task = String(args.task);
    const type = String(args.type) as ThoughtType;
    const model = args.model ? String(args.model) : undefined;
    const mode = (args.mode as string) ?? "background";
    const todoId = args.todoId ? String(args.todoId) : undefined;

    if (!THOUGHT_DEFAULTS[type]) {
      return JSON.stringify({ error: `Invalid thought type: ${type}` });
    }

    const parentType = detectParentType(ctx.brainId);
    if (parentType !== null) {
      const allowed = RECURSION_RULES[parentType];
      if (!allowed.includes(type)) {
        return JSON.stringify({
          error: `Recursion limit: ${parentType} can only spawn [${allowed.join(",")}], not ${type}`,
        });
      }
    }

    const thoughtId = generateThoughtId();
    const defaults = THOUGHT_DEFAULTS[type];
    const effectiveModel = model ?? defaults.model;

    const allTools = (ctx as any).__allTools as ToolDefinition[] | undefined;
    let tools: ToolDefinition[];

    if (type === "act" && allTools) {
      tools = allTools.filter(t => t.name !== "manage_brain" && t.name !== "spawn_thought");
    } else if (allTools) {
      tools = allTools.filter(t => defaults.tools.includes(t.name));
    } else {
      tools = [];
    }

    const slotRegistry = new SlotRegistry();
    const contextEngine = new ContextEngine(slotRegistry);

    slotRegistry.register("thought:identity", [
      `You are a ${type} thought (id: ${thoughtId}) spawned by brain "${ctx.brainId}".`,
      `Your task: ${task}`,
      defaults.readOnly ? "You are in READ-ONLY mode. Do not modify any files." : "",
      `Max iterations: ${defaults.maxIterations}`,
    ].filter(Boolean).join("\n"));

    ctx.slot.register(`thought:${thoughtId}`, `[thought:${thoughtId}] status: launched, type: ${type}`);

    const parentBrainId = ctx.brainId.split(":")[0];
    const thoughtBrainId = `${ctx.brainId}:${thoughtId}`;

    ctx.brainBoard.set(thoughtBrainId, "status", "running");
    ctx.brainBoard.set(thoughtBrainId, "type", type);
    ctx.brainBoard.set(thoughtBrainId, "parent", parentBrainId);
    ctx.brainBoard.set(thoughtBrainId, "task", task.slice(0, 200));
    ctx.brainBoard.set(thoughtBrainId, "startedAt", Date.now());

    let provider: LLMProvider;
    let spec: ModelSpec;
    try {
      let inheritedModel = "gemini-2.0-flash";
      try {
        const brainJson = JSON.parse(await readFile(join(ctx.pathManager.brainDir(parentBrainId), "brain.json"), "utf-8"));
        inheritedModel = Array.isArray(brainJson.model) ? brainJson.model[0] : brainJson.model ?? inheritedModel;
      } catch { /* use default */ }
      const modelStr = effectiveModel ?? inheritedModel;
      provider = createProvider(modelStr);
      spec = getModelSpec(modelStr);
    } catch (err: any) {
      ctx.slot.release(`thought:${thoughtId}`);
      cleanupBoard(ctx.brainBoard, thoughtBrainId);
      return JSON.stringify({ error: `Failed to create provider: ${err.message}` });
    }

    const sessionHistory: LLMMessage[] = [
      { role: "user", content: task, ts: Date.now() },
    ];

    const logPath = join(ctx.pathManager.brainDir(parentBrainId), "logs", "thoughts");

    const runThought = async (): Promise<{ result: string; error?: string }> => {
      try {
        const response = await runAgentLoop({
          brainId: thoughtBrainId,
          provider,
          tools,
          contextEngine,
          sessionHistory,
          modelSpec: spec,
          maxIterations: defaults.maxIterations,
          signal: ctx.signal,
          brainBoard: ctx.brainBoard,
          slotRegistry,
          pathManager: ctx.pathManager,
          terminalManager: ctx.terminalManager,
          workspace: ctx.workspace,
          emit: ctx.emit,
        });

        const content = response?.content;
        const result = typeof content === "string" ? content : JSON.stringify(content ?? "");

        ctx.brainBoard.set(thoughtBrainId, "status", "completed");
        ctx.brainBoard.set(thoughtBrainId, "result", result.slice(0, 500));

        ctx.emit({
          source: `tool:spawn_thought`,
          type: "thought_result",
          payload: { thoughtId, type, result, todoId },
          ts: Date.now(),
          silent: true,
        });

        await saveThoughtLog(logPath, thoughtId, type, task, sessionHistory, result);
        return { result };
      } catch (err: any) {
        const errorMsg = err.message ?? String(err);

        ctx.brainBoard.set(thoughtBrainId, "status", "error");
        ctx.brainBoard.set(thoughtBrainId, "error", errorMsg);

        ctx.emit({
          source: `tool:spawn_thought`,
          type: "thought_error",
          payload: { thoughtId, type, error: errorMsg, todoId },
          ts: Date.now(),
          silent: true,
        });

        await saveThoughtLog(logPath, thoughtId, type, task, sessionHistory, undefined, errorMsg);
        return { result: "", error: errorMsg };
      } finally {
        ctx.slot.release(`thought:${thoughtId}`);
        cleanupBoard(ctx.brainBoard, thoughtBrainId);
      }
    };

    if (mode === "foreground") {
      const outcome = await runThought();
      if (outcome.error) {
        return JSON.stringify({ thoughtId, status: "error", error: outcome.error });
      }
      return JSON.stringify({ thoughtId, status: "completed", result: outcome.result });
    }

    const promise = runThought().catch(() => {});
    ctx.trackBackgroundTask?.(promise);

    return JSON.stringify({
      thoughtId,
      status: "launched",
      type,
      mode: "background",
    });
  },
} satisfies ToolDefinition;

function detectParentType(brainId: string): ThoughtType | null {
  if (!brainId.includes(":thought_")) return null;
  return "observe";
}

function cleanupBoard(board: BrainBoardAPI, thoughtBrainId: string): void {
  board.removeAll(thoughtBrainId);
}

async function saveThoughtLog(
  dir: string,
  thoughtId: string,
  type: string,
  task: string,
  history: LLMMessage[],
  result?: string,
  error?: string,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const lines = [
      `# Thought: ${thoughtId} (${type})`,
      `Task: ${task}`,
      `Time: ${new Date().toISOString()}`,
      `Status: ${error ? "error" : "completed"}`,
      "",
      "## Session",
      ...history.map(m => `[${m.role}] ${typeof m.content === "string" ? m.content.slice(0, 500) : "[multimodal]"}`),
      "",
      result ? `## Result\n${result.slice(0, 2000)}` : "",
      error ? `## Error\n${error}` : "",
    ].filter(Boolean);
    await appendFile(join(dir, `${thoughtId}.md`), lines.join("\n") + "\n", "utf-8");
  } catch {
    /* log save failed — non-critical */
  }
}
