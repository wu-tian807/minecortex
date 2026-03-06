/** @desc subagent — launch scheduler-managed anonymous subagents */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrainJson,
  CapabilityPathRedirects,
  CapabilitySelector,
  ToolContext,
  ToolDefinition,
  ToolOutput,
} from "../src/core/types.js";
import type { LLMMessage } from "../src/llm/types.js";
import { getScheduler } from "../src/core/scheduler.js";
import { SessionManager } from "../src/session/session-manager.js";

type SubagentType = "observe" | "plan" | "act";
type ContextMode = "none" | "summary" | "full";

const RESERVED_TOOLS = new Set(["manage_brain", "subagent"]);
const COMPLETION_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 300;

const SUBAGENT_DEFAULTS: Record<SubagentType, {
  readOnly: boolean;
  tools: string[];
  model?: string;
}> = {
  observe: {
    readOnly: true,
    tools: ["read_file", "glob", "grep", "shell", "list_dir"],
    model: "gemini-2.5-flash",
  },
  plan: {
    readOnly: true,
    tools: ["read_file", "glob", "grep", "shell", "list_dir"],
  },
  act: {
    readOnly: false,
    tools: [],
  },
};

const RECURSION_RULES: Record<SubagentType, SubagentType[]> = {
  observe: [],
  plan: ["observe"],
  act: ["observe"],
};

export default {
  name: "subagent",
  description:
    "Launch a scheduler-managed subagent for a focused task. " +
    "Types: observe (read-only exploration), plan (read-only planning), act (can modify). " +
    "Background mode returns immediately; foreground mode awaits the final result.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task for the subagent to perform",
      },
      type: {
        type: "string",
        enum: ["observe", "plan", "act"],
        description: "Subagent type: observe (read-only, fast), plan (read-only), act (full tools)",
      },
      model: {
        type: "string",
        description: "Override model for this subagent (default: inherit from parent brain)",
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
        description: "Optional: associate this subagent with a todo item for tracking",
      },
    },
    required: ["task", "type"],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const task = String(args.task ?? "").trim();
    const type = String(args.type ?? "") as SubagentType;
    const model = args.model ? String(args.model) : undefined;
    const mode = (args.mode as string) ?? "background";
    const contextMode = (args.context as string) ?? "none";
    const todoId = args.todoId ? String(args.todoId) : undefined;

    if (!task) return JSON.stringify({ error: "task is required" });
    if (!SUBAGENT_DEFAULTS[type]) {
      return JSON.stringify({ error: `Invalid subagent type: ${type}` });
    }
    if (mode !== "background" && mode !== "foreground") {
      return JSON.stringify({ error: `Invalid mode: ${mode}` });
    }
    if (contextMode !== "none" && contextMode !== "summary" && contextMode !== "full") {
      return JSON.stringify({ error: `Invalid context mode: ${contextMode}` });
    }

    const scheduler = getScheduler();
    if (!scheduler) return JSON.stringify({ error: "Scheduler not running." });

    const parentType = detectParentType(ctx);
    if (parentType !== null) {
      const allowed = RECURSION_RULES[parentType];
      if (!allowed.includes(type)) {
        return JSON.stringify({
          error: `Recursion limit: ${parentType} can only spawn [${allowed.join(",")}], not ${type}`,
        });
      }
    }

    const subagentId = generateSubagentId(ctx.brainId);
    const slotId = `subagent:${subagentId}`;
    const defaults = SUBAGENT_DEFAULTS[type];
    const parentConfig = await loadParentBrainConfig(ctx);
    const effectiveModel = model ?? resolveModelFromBrainConfig(parentConfig, defaults.model);
    const initialPrompt = await buildInitialPrompt(ctx, task, contextMode);
    const toolsSelector = buildToolsSelector(type, parentConfig.tools);
    const capabilityPaths = buildSubagentCapabilityPaths(ctx, parentConfig.paths);

    ctx.slot.register(slotId, `[subagent:${subagentId}] status: launched, type: ${type}`);
    markSubagentBoard(ctx, subagentId, type, task, "launched");

    const sessionManager = new SessionManager(subagentId, ctx.pathManager);

    try {
      assertSchedulerResult(await scheduler.controlBrain("create", subagentId, {
        model: effectiveModel,
        soul: buildSubagentSoul(subagentId, ctx.brainId, type, defaults.readOnly),
        subscriptions: { global: "none", enable: ["recorder"] },
        tools: toolsSelector,
        slots: { global: "all" },
        paths: capabilityPaths,
      }));

      await sessionManager.newSession([
        { role: "user", content: initialPrompt, ts: Date.now() },
      ]);

      markSubagentBoard(ctx, subagentId, type, task, "running");
      ctx.slot.update(slotId, `[subagent:${subagentId}] status: running, type: ${type}`);

      assertSchedulerResult(await scheduler.controlBrain("start", subagentId));
      assertSchedulerResult(await scheduler.controlBrain("resume", subagentId));
    } catch (err: any) {
      ctx.slot.release(slotId);
      ctx.brainBoard.removeAll(subagentId);
      await scheduler.controlBrain("free", subagentId).catch(() => {});
      return JSON.stringify({ error: `Failed to launch subagent: ${err.message ?? String(err)}` });
    }

    if (mode === "foreground") {
      const outcome = await waitForSubagentCompletion({
        scheduler,
        sessionManager,
        subagentId,
        signal: ctx.signal,
      });
      ctx.slot.release(slotId);
      await scheduler.controlBrain("free", subagentId).catch(() => {});

      if (outcome.status === "completed") {
        return JSON.stringify({ subagentId, status: "completed", result: outcome.result });
      }
      return JSON.stringify({ subagentId, status: "error", error: outcome.error });
    }

    const monitor = monitorSubagentInBackground({
      ctx,
      scheduler,
      sessionManager,
      subagentId,
      type,
      todoId,
      slotId,
    });
    ctx.trackBackgroundTask?.(monitor);

    return JSON.stringify({
      subagentId,
      status: "launched",
      type,
      mode: "background",
    });
  },
} satisfies ToolDefinition;

function detectParentType(ctx: ToolContext): SubagentType | null {
  const value = ctx.brainBoard.get(ctx.brainId, "subagentType");
  if (value === "observe" || value === "plan" || value === "act") return value;
  return null;
}

function generateSubagentId(parentBrainId: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const parent = parentBrainId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-24) || "brain";
  return `subagent_${parent}_${Date.now()}_${rand}`;
}

async function loadParentBrainConfig(
  ctx: ToolContext,
): Promise<BrainJson> {
  try {
    const raw = await readFile(join(ctx.pathManager.brainDir(ctx.brainId), "brain.json"), "utf-8");
    return JSON.parse(raw) as BrainJson;
  } catch {
    return {};
  }
}

function buildToolsSelector(
  type: SubagentType,
  parentTools?: CapabilitySelector,
): CapabilitySelector {
  if (type !== "act") {
    return {
      global: "none",
      enable: SUBAGENT_DEFAULTS[type].tools.filter((name) => !RESERVED_TOOLS.has(name)),
    };
  }

  if (!parentTools) {
    return { global: "all", disable: [...RESERVED_TOOLS] };
  }

  if (parentTools.global === "all") {
    return {
      ...parentTools,
      disable: [...new Set([...(parentTools.disable ?? []), ...RESERVED_TOOLS])],
    };
  }

  return {
    global: "none",
    enable: (parentTools.enable ?? []).filter((name) => !RESERVED_TOOLS.has(name)),
    config: parentTools.config,
  };
}

function resolveModelFromBrainConfig(
  brainJson: BrainJson,
  fallback = "gemini-2.0-flash",
): string {
  const model = brainJson.models?.model;
  if (Array.isArray(model)) return model[0] ?? fallback;
  return model ?? fallback;
}

function buildSubagentCapabilityPaths(
  ctx: ToolContext,
  inherited?: CapabilityPathRedirects,
): CapabilityPathRedirects {
  return {
    tools: inherited?.tools ?? `brains/${ctx.brainId}/tools`,
    slots: inherited?.slots ?? `brains/${ctx.brainId}/slots`,
    subscriptions: inherited?.subscriptions ?? `brains/${ctx.brainId}/subscriptions`,
  };
}

function buildSubagentSoul(
  subagentId: string,
  parentBrainId: string,
  type: SubagentType,
  readOnly: boolean,
): string {
  return [
    `# ${subagentId}`,
    "",
    `你是由 brain \`${parentBrainId}\` 启动的一次性 ${type} subagent。`,
    "",
    "## 约束",
    "- 默认中文回复，代码注释用英文",
    readOnly ? "- 当前为只读模式，不要修改文件" : "- 当前可执行修改，但只为当前任务做最小改动",
    "- 不要调用 manage_brain 或再次调用 subagent",
    "- 完成后必须给出明确的最终文本总结，不要无限继续调用工具",
    "",
    "## 工作方式",
    "1. 先快速理解当前任务和上下文",
    "2. 必要时调用工具收集信息或执行",
    "3. 收尾时给出简洁结果，便于父 brain 直接复用",
    "",
  ].filter(Boolean).join("\n");
}

function assertSchedulerResult(result: string): void {
  const lowered = result.toLowerCase();
  if (
    lowered.startsWith("unknown ") ||
    lowered.startsWith("invalid ") ||
    lowered.includes(" not found") ||
    lowered.includes("already exists")
  ) {
    throw new Error(result);
  }
}

async function buildInitialPrompt(
  ctx: ToolContext,
  task: string,
  contextMode: ContextMode,
): Promise<string> {
  if (contextMode === "none") return task;

  const sessionManager = new SessionManager(ctx.brainId, ctx.pathManager);
  const history = await sessionManager.loadPromptHistory({ keepToolResults: 4 });
  const contextText = renderParentContext(history, contextMode);
  if (!contextText) return task;

  return [
    "Primary task:",
    task,
    "",
    "Parent context for reference:",
    contextText,
  ].join("\n");
}

function renderParentContext(history: LLMMessage[], contextMode: ContextMode): string {
  const maxMessages = contextMode === "summary" ? 8 : 20;
  const maxChars = contextMode === "summary" ? 6000 : 16000;

  const relevant = history
    .filter((msg) => msg.role !== "tool")
    .slice(-maxMessages)
    .map((msg) => `[${msg.role}] ${serializeContent(msg.content)}`)
    .filter((line) => line.trim().length > 0);

  if (relevant.length === 0) return "";

  let text = relevant.join("\n\n");
  if (text.length > maxChars) {
    text = `[truncated]\n${text.slice(text.length - maxChars)}`;
  }
  return text;
}

function serializeContent(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return stripThinking(content).replace(/\s+/g, " ").trim();
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "[unserializable content]";
  }
}

function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trim();
}

function markSubagentBoard(
  ctx: ToolContext,
  subagentId: string,
  type: SubagentType,
  task: string,
  status: string,
): void {
  ctx.brainBoard.set(subagentId, "kind", "subagent");
  ctx.brainBoard.set(subagentId, "subagentType", type);
  ctx.brainBoard.set(subagentId, "parent", ctx.brainId);
  ctx.brainBoard.set(subagentId, "task", task.slice(0, 200));
  ctx.brainBoard.set(subagentId, "status", status);
  ctx.brainBoard.set(subagentId, "startedAt", new Date().toISOString());
}

async function monitorSubagentInBackground(opts: {
  ctx: ToolContext;
  scheduler: NonNullable<ReturnType<typeof getScheduler>>;
  sessionManager: SessionManager;
  subagentId: string;
  type: SubagentType;
  todoId?: string;
  slotId: string;
}): Promise<void> {
  const { ctx, scheduler, sessionManager, subagentId, type, todoId, slotId } = opts;

  try {
    const outcome = await waitForSubagentCompletion({
      scheduler,
      sessionManager,
      subagentId,
    });

    if (outcome.status === "completed") {
      ctx.eventBus.emitToSelf({
        source: "tool:subagent",
        type: "subagent_result",
        payload: { subagentId, type, result: outcome.result, todoId },
        ts: Date.now(),
        priority: 0,
      });
    } else {
      ctx.eventBus.emitToSelf({
        source: "tool:subagent",
        type: "subagent_error",
        payload: { subagentId, type, error: outcome.error, todoId },
        ts: Date.now(),
        priority: 0,
      });
    }
  } finally {
    ctx.slot.release(slotId);
    await scheduler.controlBrain("free", subagentId).catch(() => {});
  }
}

async function waitForSubagentCompletion(opts: {
  scheduler: NonNullable<ReturnType<typeof getScheduler>>;
  sessionManager: SessionManager;
  subagentId: string;
  signal?: AbortSignal;
}): Promise<
  | { status: "completed"; result: string }
  | { status: "error"; error: string }
> {
  const { scheduler, sessionManager, subagentId, signal } = opts;
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await scheduler.controlBrain("stop", subagentId).catch(() => {});
      return { status: "error", error: "Subagent interrupted by parent turn." };
    }

    const messages = await sessionManager.loadSession();
    const result = pickCompletedResult(messages);
    if (result) {
      return { status: "completed", result };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return {
    status: "error",
    error: `Timed out waiting for subagent completion after ${COMPLETION_TIMEOUT_MS}ms.`,
  };
}

function pickCompletedResult(messages: LLMMessage[]): string | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return null;
  if (last.toolCalls && last.toolCalls.length > 0) return null;

  const text = serializeContent(last.content);
  return text || "[subagent completed but produced no text summary]";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
