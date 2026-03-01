/** @desc spawn_thought — launch sub-agent "thoughts" with recursion limits */

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

    let provider: LLMProvider;
    let spec: ModelSpec;
    try {
      const modelStr = effectiveModel ?? (ctx.brainBoard.get(ctx.brainId, "model") as string) ?? "gemini-2.0-flash";
      provider = createProvider(modelStr);
      spec = getModelSpec(modelStr);
    } catch (err: any) {
      ctx.slot.release(`thought:${thoughtId}`);
      return JSON.stringify({ error: `Failed to create provider: ${err.message}` });
    }

    const sessionHistory: LLMMessage[] = [
      { role: "user", content: task, ts: Date.now() },
    ];

    const runThought = async (): Promise<{ result: string; error?: string }> => {
      try {
        const response = await runAgentLoop({
          brainId: `${ctx.brainId}:${thoughtId}`,
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

        ctx.emit({
          source: `tool:spawn_thought`,
          type: "thought_result",
          payload: { thoughtId, type, result, todoId },
          ts: Date.now(),
          silent: true,
        });

        return { result };
      } catch (err: any) {
        const errorMsg = err.message ?? String(err);

        ctx.emit({
          source: `tool:spawn_thought`,
          type: "thought_error",
          payload: { thoughtId, type, error: errorMsg, todoId },
          ts: Date.now(),
          silent: true,
        });

        return { result: "", error: errorMsg };
      } finally {
        ctx.slot.release(`thought:${thoughtId}`);
      }
    };

    if (mode === "foreground") {
      const outcome = await runThought();
      if (outcome.error) {
        return JSON.stringify({ thoughtId, status: "error", error: outcome.error });
      }
      return JSON.stringify({ thoughtId, status: "completed", result: outcome.result });
    }

    runThought().catch(() => {});

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
  // Anonymous thoughts cannot determine their type from ID alone,
  // so we conservatively treat them as "observe" (most restrictive).
  return "observe";
}
