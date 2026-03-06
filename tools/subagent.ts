/** @desc subagent — launch scheduler-managed anonymous subagents */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrainJson,
  ToolContext,
  ToolDefinition,
  ToolOutput,
} from "../src/core/types.js";
import { getScheduler } from "../src/core/scheduler.js";
import { SessionManager } from "../src/session/session-manager.js";
import {
  buildToolsSelector,
  isSubagentEffort,
  isSubagentType,
  RECURSION_RULES,
  resolveSubagentMode,
  SUBAGENT_DEFAULTS,
} from "./subagents/defaults.js";
import { buildInitialPrompt } from "./subagents/context.js";
import {
  waitForSubagentCompletion,
  type SubagentOutcome,
} from "./subagents/monitor.js";
import { buildSubagentSoul } from "./subagents/soul.js";
import {
  type ContextMode,
  type SubagentAction,
  type SubagentEffort,
  type SubagentMode,
  type SubagentType,
} from "./subagents/types.js";
import { renderWritePlanToolSource } from "./subagents/write-plan-template.js";

type ActiveSubagentEntry = {
  id: string;
  type: SubagentType;
  request: string;
  startedAt: string;
};

export default {
  name: "subagent",
  description:
    "Launch a scheduler-managed subagent for a focused task. " +
    "Types: observe (read-only exploration, default foreground), " +
    "plan (read-only planning, default foreground), act (can modify, default foreground). " +
    "For observe/explore tasks, always prefer absolute file or directory paths in the task text so weaker models do not get lost. " +
    "Supports stateful question/reply for any subagent type. " +
    "Only use action=reply after a previous subagent call returned status=question for that same subagent.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["launch", "reply"],
        description: "launch: create a new subagent. reply: send a follow-up answer to the same live subagent, but only after it previously returned status=question.",
      },
      task: {
        type: "string",
        description: "The task for a new subagent to perform. For observe/explore tasks, include absolute file or directory paths whenever possible.",
      },
      type: {
        type: "string",
        enum: ["observe", "plan", "act"],
        description: "Subagent type for launch: observe (read-only, fast; prefer absolute paths in task text), plan (read-only), act (full tools)",
      },
      quality: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Subagent quality tier: low=gemini-2.5-flash, medium=parent model, high=claude-opus-4-6",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Alias of quality. low=gemini-2.5-flash, medium=parent model, high=claude-opus-4-6",
      },
      mode: {
        type: "string",
        enum: ["background", "foreground"],
        description: "background: return immediately; foreground: await result. Defaults depend on subagent type.",
      },
      context: {
        type: "string",
        enum: ["none", "summary", "full"],
        description: "How much parent context to pass during launch (default: none)",
      },
      subagentId: {
        type: "string",
        description: "Existing live subagent id to target when action=reply. This must be the same subagent that previously returned status=question.",
      },
      reply: {
        type: "string",
        description: "Parent or user reply content when action=reply. Only provide this after that subagent returned a question.",
      },
    },
    required: [],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const action = String(args.action ?? "launch").trim() as SubagentAction;
    const scheduler = getScheduler();
    if (!scheduler) return JSON.stringify({ error: "Scheduler not running." });

    if (action === "reply") {
      return await replyToSubagent(args, ctx, scheduler);
    }
    if (action !== "launch") {
      return JSON.stringify({ error: `Invalid action: ${action}` });
    }
    return await launchSubagent(args, ctx, scheduler);
  },
} satisfies ToolDefinition;

function detectParentType(ctx: ToolContext): SubagentType | null {
  const value = ctx.brainBoard.get(ctx.brainId, "subagentType");
  if (typeof value === "string" && isSubagentType(value)) return value;
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

function resolveModelFromBrainConfig(
  brainJson: BrainJson,
  fallback = "gemini-2.0-flash",
): string {
  const model = brainJson.models?.model;
  if (Array.isArray(model)) return model[0] ?? fallback;
  return model ?? fallback;
}

function resolveRequestedEffort(args: Record<string, unknown>): SubagentEffort | null {
  if (args.model !== undefined) {
    throw new Error("model is no longer supported; use quality or effort with low/medium/high.");
  }

  const quality = args.quality == null ? undefined : String(args.quality).trim();
  const effort = args.effort == null ? undefined : String(args.effort).trim();

  if (quality && !isSubagentEffort(quality)) return null;
  if (effort && !isSubagentEffort(effort)) return null;
  if (quality && effort && quality !== effort) {
    throw new Error(`quality (${quality}) conflicts with effort (${effort}).`);
  }

  return (quality ?? effort ?? undefined) as SubagentEffort | undefined ?? null;
}

function resolveSubagentModel(
  parentConfig: BrainJson,
  defaultEffort: SubagentEffort,
  requestedEffort: SubagentEffort | null,
): string {
  const effort = requestedEffort ?? defaultEffort;
  switch (effort) {
    case "low":
      return "gemini-2.5-flash";
    case "medium":
      return resolveModelFromBrainConfig(parentConfig);
    case "high":
      return "claude-opus-4-6";
  }
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
}): Promise<void> {
  const { ctx, scheduler, sessionManager, subagentId, type } = opts;

  const outcome = await waitForSubagentCompletion({
    scheduler,
    sessionManager,
    subagentId,
  });

  if (outcome.status === "question") {
    recordQuestionState(ctx, subagentId, outcome.question);
    ctx.eventBus.emitToSelf({
      source: "tool:subagent",
      type: "subagent_question",
      payload: { subagentId, type, question: outcome.question },
      ts: Date.now(),
      priority: 0,
      handoff: "innerLoop",
    });
    return;
  }

  await finalizeSubagent(ctx, scheduler, subagentId, outcome.status);
  if (outcome.status === "completed") {
    ctx.eventBus.emitToSelf({
      source: "tool:subagent",
      type: "subagent_result",
      payload: { subagentId, type, result: outcome.result },
      ts: Date.now(),
      priority: 0,
      handoff: "turn",
    });
    return;
  }

  ctx.eventBus.emitToSelf({
    source: "tool:subagent",
    type: "subagent_error",
    payload: { subagentId, type, error: outcome.error },
    ts: Date.now(),
    priority: 0,
    handoff: "turn",
  });
}

async function launchSubagent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  scheduler: NonNullable<ReturnType<typeof getScheduler>>,
): Promise<ToolOutput> {
  const task = String(args.task ?? "").trim();
  const typeRaw = String(args.type ?? "").trim();
  const contextModeRaw = String(args.context ?? "none").trim();

  if (!task) return JSON.stringify({ error: "task is required for action=launch" });
  if (!isSubagentType(typeRaw)) {
    return JSON.stringify({ error: `Invalid subagent type: ${typeRaw}` });
  }
  if (!isContextMode(contextModeRaw)) {
    return JSON.stringify({ error: `Invalid context mode: ${contextModeRaw}` });
  }

  const type = typeRaw;
  const mode = resolveSubagentMode(type, args.mode ? String(args.mode) : undefined);
  if (!mode) {
    return JSON.stringify({ error: `Invalid mode: ${String(args.mode)}` });
  }
  let requestedEffort: SubagentEffort | null;
  try {
    requestedEffort = resolveRequestedEffort(args);
  } catch (err: any) {
    return JSON.stringify({ error: err.message ?? String(err) });
  }
  if ((args.quality != null || args.effort != null) && requestedEffort === null) {
    return JSON.stringify({ error: "Invalid quality/effort. Use one of: low, medium, high." });
  }

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
  const defaults = SUBAGENT_DEFAULTS[type];
  const parentConfig = await loadParentBrainConfig(ctx);
  const effectiveModel = resolveSubagentModel(parentConfig, defaults.defaultEffort, requestedEffort);
  const initialPrompt = await buildInitialPrompt(ctx, task, contextModeRaw);
  const toolsSelector = buildToolsSelector(type);
  const sessionManager = new SessionManager(subagentId, ctx.pathManager);
  const defaultPlanName = buildDefaultPlanName(task, subagentId);

  addActiveSubagent(ctx, ctx.brainId, {
    id: subagentId,
    type,
    request: task,
    startedAt: new Date().toISOString(),
  });
  markSubagentBoard(ctx, subagentId, type, task, "launched");
  ctx.brainBoard.set(subagentId, "returnMode", mode);

  try {
    assertSchedulerResult(await scheduler.controlBrain("create", subagentId, {
      model: effectiveModel,
      soul: buildSubagentSoul(subagentId, ctx.brainId, type, defaults.readOnly),
      subscriptions: { global: "none", enable: ["recorder"] },
      tools: toolsSelector,
      slots: { global: "all" },
    }));

    if (type === "plan") {
      await injectPlanTool(ctx, subagentId, ctx.brainId, defaultPlanName);
    }

    assertSchedulerResult(await scheduler.controlBrain("start", subagentId));
    dispatchSubagentPrompt(scheduler, subagentId, "launch", initialPrompt);
    markSubagentRunning(ctx, subagentId);
  } catch (err: any) {
    await finalizeSubagent(ctx, scheduler, subagentId);
    return JSON.stringify({ error: `Failed to launch subagent: ${err.message ?? String(err)}` });
  }

  if (mode === "foreground") {
    const outcome = await waitForSubagentCompletion({
      scheduler,
      sessionManager,
      subagentId,
      signal: ctx.signal,
    });
    return await handleForegroundOutcome({
      ctx,
      scheduler,
      subagentId,
      type,
      outcome,
    });
  }

  const monitor = monitorSubagentInBackground({
    ctx,
    scheduler,
    sessionManager,
    subagentId,
    type,
  });
  ctx.trackBackgroundTask?.(monitor);

  return JSON.stringify({
    subagentId,
    status: "launched",
    type,
    mode: "background",
  });
}

async function replyToSubagent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  scheduler: NonNullable<ReturnType<typeof getScheduler>>,
): Promise<ToolOutput> {
  const subagentId = String(args.subagentId ?? "").trim();
  const reply = String(args.reply ?? "").trim();
  if (!subagentId) return JSON.stringify({ error: "subagentId is required for action=reply" });
  if (!reply) return JSON.stringify({ error: "reply is required for action=reply" });

  const parent = ctx.brainBoard.get(subagentId, "parent");
  if (parent !== ctx.brainId) {
    return JSON.stringify({ error: `Subagent '${subagentId}' is not owned by brain '${ctx.brainId}'.` });
  }

  const typeValue = ctx.brainBoard.get(subagentId, "subagentType");
  if (typeof typeValue !== "string" || !isSubagentType(typeValue)) {
    return JSON.stringify({ error: `Unable to resolve subagent type for '${subagentId}'.` });
  }

  const statusValue = String(ctx.brainBoard.get(subagentId, "status") ?? "");
  if (statusValue !== "waiting_reply") {
    return JSON.stringify({
      error: `Subagent '${subagentId}' is not awaiting a reply (status=${statusValue || "unknown"}).`,
    });
  }

  const mode = resolveReplyMode(ctx, subagentId, typeValue, args.mode ? String(args.mode) : undefined);
  if (!mode) {
    return JSON.stringify({ error: `Invalid mode: ${String(args.mode)}` });
  }

  const sessionManager = new SessionManager(subagentId, ctx.pathManager);
  const parentBrainId = String(parent);

  updateActiveSubagentRequest(ctx, parentBrainId, subagentId, reply);

  try {
    dispatchSubagentPrompt(scheduler, subagentId, "reply", buildReplyMessage(reply));
  } catch (err: any) {
    return JSON.stringify({ error: `Failed to deliver reply to subagent: ${err.message ?? String(err)}` });
  }

  ctx.brainBoard.set(subagentId, "returnMode", mode);
  clearQuestionState(ctx, subagentId);
  markSubagentRunning(ctx, subagentId);

  if (mode === "foreground") {
    const outcome = await waitForSubagentCompletion({
      scheduler,
      sessionManager,
      subagentId,
      signal: ctx.signal,
    });
    return await handleForegroundOutcome({
      ctx,
      scheduler,
      subagentId,
      type: typeValue,
      outcome,
    });
  }

  const monitor = monitorSubagentInBackground({
    ctx,
    scheduler,
    sessionManager,
    subagentId,
    type: typeValue,
  });
  ctx.trackBackgroundTask?.(monitor);

  return JSON.stringify({
    subagentId,
    status: "replied",
    type: typeValue,
    mode: "background",
  });
}

async function handleForegroundOutcome(opts: {
  ctx: ToolContext;
  scheduler: NonNullable<ReturnType<typeof getScheduler>>;
  subagentId: string;
  type: SubagentType;
  outcome: SubagentOutcome;
}): Promise<ToolOutput> {
  const { ctx, scheduler, subagentId, type, outcome } = opts;

  if (outcome.status === "question") {
    ctx.brainBoard.set(subagentId, "returnMode", "foreground");
    recordQuestionState(ctx, subagentId, outcome.question);
    return JSON.stringify({ subagentId, status: "question", question: outcome.question });
  }

  await finalizeSubagent(ctx, scheduler, subagentId, outcome.status);
  if (outcome.status === "completed") {
    return JSON.stringify({ subagentId, status: "completed", result: outcome.result });
  }
  return JSON.stringify({ subagentId, status: "error", error: outcome.error });
}

function markSubagentRunning(
  ctx: ToolContext,
  subagentId: string,
): void {
  ctx.brainBoard.set(subagentId, "status", "running");
  ctx.brainBoard.remove(subagentId, "lastQuestion");
  ctx.brainBoard.remove(subagentId, "questionAt");
}

function recordQuestionState(
  ctx: ToolContext,
  subagentId: string,
  question: string,
): void {
  ctx.brainBoard.set(subagentId, "status", "waiting_reply");
  ctx.brainBoard.set(subagentId, "lastQuestion", question);
  ctx.brainBoard.set(subagentId, "questionAt", new Date().toISOString());
}

function clearQuestionState(ctx: ToolContext, subagentId: string): void {
  ctx.brainBoard.remove(subagentId, "lastQuestion");
  ctx.brainBoard.remove(subagentId, "questionAt");
}

async function injectPlanTool(
  ctx: ToolContext,
  subagentId: string,
  parentBrainId: string,
  defaultPlanName: string,
): Promise<void> {
  const toolsDir = join(ctx.pathManager.brainDir(subagentId), "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(
    join(toolsDir, "write_plan.ts"),
    renderWritePlanToolSource(parentBrainId, defaultPlanName),
    "utf-8",
  );
}

async function finalizeSubagent(
  ctx: ToolContext,
  scheduler: NonNullable<ReturnType<typeof getScheduler>>,
  subagentId: string,
  finalStatus?: "completed" | "error",
): Promise<void> {
  if (finalStatus) {
    ctx.brainBoard.set(subagentId, "status", finalStatus);
  }
  removeActiveSubagent(ctx, subagentId);
  ctx.brainBoard.removeAll(subagentId);
  await scheduler.controlBrain("free", subagentId).catch(() => {});
}

function buildReplyMessage(reply: string): string {
  return [
    "Parent reply:",
    reply,
  ].join("\n");
}

function dispatchSubagentPrompt(
  scheduler: NonNullable<ReturnType<typeof getScheduler>>,
  subagentId: string,
  kind: "launch" | "reply",
  prompt: string,
): void {
  const brain = scheduler.getBrain(subagentId);
  if (!brain) {
    throw new Error(`Subagent '${subagentId}' is not running.`);
  }
  brain.pushEvent({
    source: "tool:subagent",
    type: kind === "launch" ? "subagent_task" : "subagent_reply",
    payload: { prompt },
    ts: Date.now(),
    priority: 0,
  });
}

function isContextMode(value: string): value is ContextMode {
  return value === "none" || value === "summary" || value === "full";
}

function resolveReplyMode(
  ctx: ToolContext,
  subagentId: string,
  type: SubagentType,
  requested?: string,
): SubagentMode | null {
  if (requested) return resolveSubagentMode(type, requested);
  const stored = ctx.brainBoard.get(subagentId, "returnMode");
  if (stored === "foreground" || stored === "background") return stored;
  return resolveSubagentMode(type);
}

function buildDefaultPlanName(task: string, subagentId: string): string {
  const slug = task
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `plan-${subagentId.slice(-12).toLowerCase()}`;
}

function addActiveSubagent(
  ctx: ToolContext,
  parentBrainId: string,
  entry: ActiveSubagentEntry,
): void {
  const current = getActiveSubagents(ctx, parentBrainId)
    .filter((item) => item.id !== entry.id);
  current.push(entry);
  ctx.brainBoard.set(parentBrainId, "subagents.actives", current);
}

function updateActiveSubagentRequest(
  ctx: ToolContext,
  parentBrainId: string,
  subagentId: string,
  request: string,
): void {
  const current = getActiveSubagents(ctx, parentBrainId);
  let changed = false;
  const next = current.map((item) => {
    if (item.id !== subagentId) return item;
    changed = true;
    return { ...item, request };
  });
  if (changed) {
    ctx.brainBoard.set(parentBrainId, "subagents.actives", next);
  }
}

function removeActiveSubagent(ctx: ToolContext, subagentId: string): void {
  const parent = ctx.brainBoard.get(subagentId, "parent");
  if (typeof parent !== "string" || !parent) return;
  const current = getActiveSubagents(ctx, parent);
  const next = current.filter((item) => item.id !== subagentId);
  if (next.length === current.length) return;
  if (next.length === 0) {
    ctx.brainBoard.remove(parent, "subagents.actives");
  } else {
    ctx.brainBoard.set(parent, "subagents.actives", next);
  }
}

function getActiveSubagents(ctx: ToolContext, parentBrainId: string): ActiveSubagentEntry[] {
  const value = ctx.brainBoard.get(parentBrainId, "subagents.actives");
  if (!Array.isArray(value)) return [];
  return value.filter(isActiveSubagentEntry);
}

function isActiveSubagentEntry(value: unknown): value is ActiveSubagentEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.type === "string"
    && isSubagentType(item.type)
    && typeof item.request === "string"
    && typeof item.startedAt === "string";
}
