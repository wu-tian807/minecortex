/** @desc ConsciousBrain — streaming agent loop with steer interrupt & 3-level lifecycle */

import type {
  BrainInterface,
  BrainJson,
  Event,
  ToolDefinition,
  ToolContext,
  BrainBoardAPI,
  DynamicSlotAPI,
  PathManagerAPI,
  TerminalManagerAPI,
  ModelSpec,
} from "./types.js";
import type { LLMProvider, LLMMessage, LLMToolCall, LLMResponse } from "../llm/types.js";
import type { EventQueue } from "./event-queue.js";
import type { ContextEngine } from "../context/context-engine.js";
import type { SlotRegistry } from "../context/slot-registry.js";
import type { SessionManager } from "../session/session-manager.js";
import type { Logger } from "./logger.js";
import type { EventBus } from "./event-bus.js";
import type { EventSource } from "./types.js";
import { assembleResponse } from "../llm/stream.js";
import { getModelSpec } from "../llm/provider.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Reusable agent loop (shared by ConsciousBrain & spawn_thought) ───

export interface AgentLoopOpts {
  brainId: string;
  provider: LLMProvider;
  tools: ToolDefinition[];
  contextEngine: ContextEngine;
  sessionHistory: LLMMessage[];
  modelSpec: ModelSpec;
  maxIterations: number;
  signal: AbortSignal;
  brainBoard: BrainBoardAPI;
  slotRegistry: DynamicSlotAPI;
  pathManager: PathManagerAPI;
  terminalManager: TerminalManagerAPI;
  workspace: string;
  emit: (event: Event) => void;
  logger?: Logger;
  sessionManager?: SessionManager;
  turn?: number;
  onAssistantMessage?: (msg: LLMMessage) => void;
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<LLMResponse | null> {
  const {
    brainId, provider, tools, contextEngine, sessionHistory,
    modelSpec, maxIterations, signal, brainBoard, slotRegistry,
    pathManager, terminalManager, workspace, emit, logger,
    sessionManager, turn = 0, onAssistantMessage,
  } = opts;

  let iterations = 0;
  let lastResponse: LLMResponse | null = null;

  const toolCtx: ToolContext = {
    brainId,
    signal,
    emit,
    brainBoard,
    slot: slotRegistry,
    pathManager,
    terminalManager,
    workspace,
  };

  for (;;) {
    if (signal.aborted || iterations >= maxIterations) break;
    iterations++;

    const vars: Record<string, string> = {
      BRAIN_ID: brainId,
      MODEL: brainBoard.get(brainId, "model.name") as string ?? "unknown",
      TIMESTAMP: new Date().toISOString(),
    };
    const messages = contextEngine.assemblePrompt(
      [],
      sessionHistory,
      modelSpec,
      undefined,
      vars,
    );

    let response: LLMResponse;
    try {
      const stream = provider.chatStream(messages, tools, signal);
      response = await assembleResponse(stream);
    } catch (err: any) {
      if (signal.aborted) {
        logger?.warn(brainId, turn, "LLM call aborted by steer/stop");
        break;
      }
      throw err;
    }

    lastResponse = response;

    if (response.usage) {
      brainBoard.set(brainId, "tokens.lastInputTokens", response.usage.inputTokens);
      brainBoard.set(brainId, "tokens.lastOutputTokens", response.usage.outputTokens);
      const prevIn = (brainBoard.get(brainId, "tokens.totalIn") as number) ?? 0;
      const prevOut = (brainBoard.get(brainId, "tokens.totalOut") as number) ?? 0;
      brainBoard.set(brainId, "tokens.totalIn", prevIn + response.usage.inputTokens);
      brainBoard.set(brainId, "tokens.totalOut", prevOut + response.usage.outputTokens);
    }

    const assistantMsg: LLMMessage = {
      role: "assistant",
      content: response.content,
      thinking: response.thinking,
      toolCalls: response.toolCalls,
      ts: Date.now(),
    };

    if (signal.aborted) {
      assistantMsg.truncated = true;
      sessionHistory.push(assistantMsg);
      await sessionManager?.appendMessage(assistantMsg);
      break;
    }

    sessionHistory.push(assistantMsg);
    await sessionManager?.appendMessage(assistantMsg);
    onAssistantMessage?.(assistantMsg);

    if (response.content && typeof response.content === "string" && response.content.trim()) {
      logger?.info(brainId, turn, response.content);
    }

    if (!response.toolCalls || response.toolCalls.length === 0) break;

    const results = await Promise.all(
      response.toolCalls.map(async (tc) => {
        const result = await executeTool(tc, tools, toolCtx, logger, brainId, turn);
        return { tc, result };
      }),
    );

    for (const { tc, result } of results) {
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      const toolMsg: LLMMessage = {
        role: "tool",
        content: resultStr,
        toolCallId: tc.id,
        ts: Date.now(),
      };
      sessionHistory.push(toolMsg);
      await sessionManager?.appendMessage(toolMsg);
    }
  }

  return lastResponse;
}

async function executeTool(
  tc: LLMToolCall,
  tools: ToolDefinition[],
  ctx: ToolContext,
  logger?: Logger,
  brainId = "",
  turn = 0,
): Promise<unknown> {
  const tool = tools.find(t => t.name === tc.name);
  if (!tool) return { error: `Unknown tool: ${tc.name}` };

  logger?.debug(brainId, turn, `tool:${tc.name}(${JSON.stringify(tc.arguments).slice(0, 120)})`);
  try {
    const result = await tool.execute(tc.arguments, ctx);
    const preview = typeof result === "string"
      ? result.slice(0, 200)
      : JSON.stringify(result).slice(0, 200);
    logger?.debug(brainId, turn, `tool:${tc.name} → ${preview}`);
    return result;
  } catch (err: any) {
    logger?.error(brainId, turn, `tool:${tc.name} failed`, err);
    return { error: err.message };
  }
}

// ─── Micro-compact: trim old tool results to save tokens ───

function microCompact(history: LLMMessage[], keepToolResults = 5): void {
  let toolResultCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "tool") {
      toolResultCount++;
      if (toolResultCount > keepToolResults) {
        const content = typeof history[i].content === "string"
          ? history[i].content as string
          : JSON.stringify(history[i].content);
        if (content.length > 200) {
          history[i] = { ...history[i], content: content.slice(0, 100) + "… [truncated]" };
        }
      }
    }
  }
}

// ─── ConsciousBrain ───

export interface ConsciousBrainOpts {
  id: string;
  model: string;
  provider: LLMProvider;
  tools: ToolDefinition[];
  brainConfig: BrainJson;
  eventQueue: EventQueue;
  coalesceMs: number;
  emit: (event: Event) => void;
  brainBoard: BrainBoardAPI;
  slotRegistry: SlotRegistry;
  contextEngine: ContextEngine;
  pathManager: PathManagerAPI;
  terminalManager: TerminalManagerAPI;
  logger: Logger;
  sessionManager: SessionManager;
  modelSpec: ModelSpec;
  eventBus: EventBus;
  sources: EventSource[];
  workspace: string;
}

export class ConsciousBrain implements BrainInterface {
  readonly id: string;
  private model: string;
  private provider: LLMProvider;
  private tools: ToolDefinition[];
  private brainConfig: BrainJson;
  private eventQueue: EventQueue;
  private coalesceMs: number;
  private emitFn: (event: Event) => void;
  private brainBoard: BrainBoardAPI;
  private slotRegistry: SlotRegistry;
  private contextEngine: ContextEngine;
  private pathManager: PathManagerAPI;
  private terminalManager: TerminalManagerAPI;
  private logger: Logger;
  private sessionManager: SessionManager;
  private sessionHistory: LLMMessage[] = [];
  private modelSpec: ModelSpec;
  private eventBus: EventBus;
  private sources: EventSource[];
  private workspace: string;
  private currentTurn = 0;
  private turnAbort: AbortController | null = null;

  constructor(opts: ConsciousBrainOpts) {
    this.id = opts.id;
    this.model = opts.model;
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.brainConfig = opts.brainConfig;
    this.eventQueue = opts.eventQueue;
    this.coalesceMs = opts.coalesceMs;
    this.emitFn = opts.emit;
    this.brainBoard = opts.brainBoard;
    this.slotRegistry = opts.slotRegistry;
    this.contextEngine = opts.contextEngine;
    this.pathManager = opts.pathManager;
    this.terminalManager = opts.terminalManager;
    this.logger = opts.logger;
    this.sessionManager = opts.sessionManager;
    this.modelSpec = opts.modelSpec;
    this.eventBus = opts.eventBus;
    this.sources = opts.sources;
    this.workspace = opts.workspace;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.brainBoard.set(this.id, "status", "running");
    this.brainBoard.set(this.id, "currentTurn", 0);
    this.brainBoard.set(this.id, "model.name", this.model);
    this.brainBoard.set(this.id, "model.contextWindow", this.modelSpec.contextWindow);

    const existing = await this.sessionManager.loadSession();
    if (existing.length > 0) {
      this.sessionHistory = existing;
    }

    while (!signal.aborted) {
      let trigger: Event;
      try {
        trigger = await this.eventQueue.waitForEvent(signal);
      } catch {
        break;
      }

      if (this.eventQueue.hasSteerEvent()) {
        // Skip coalesce for steer events — process immediately
      } else if ((trigger.priority ?? 1) > 0 && this.coalesceMs > 0) {
        await sleep(this.coalesceMs);
      }

      const events = this.eventQueue.drain();
      if (events.length === 0) continue;

      this.currentTurn++;
      this.brainBoard.set(this.id, "currentTurn", this.currentTurn);
      this.brainBoard.set(this.id, "lastActivity", Date.now());

      this.turnAbort = new AbortController();
      const combinedSignal = combineSignals(signal, this.turnAbort.signal);

      const steerWatcher = this.eventQueue.onSteer(() => {
        this.turnAbort?.abort();
      });

      this.logger.info(this.id, this.currentTurn, `▶ process [${events.length} events]`);

      try {
        await this.process(events, combinedSignal);
      } catch (err: any) {
        if (!combinedSignal.aborted) {
          this.logger.error(this.id, this.currentTurn, "process failed", err);
        }
      } finally {
        steerWatcher.dispose();
        this.turnAbort = null;
      }
    }

    this.brainBoard.set(this.id, "status", "stopped");
  }

  private async process(events: Event[], signal: AbortSignal): Promise<void> {
    const eventSlots = new (await import("../context/event-router.js")).EventRouter().routeEvents(events);
    for (const slot of eventSlots) {
      this.slotRegistry.registerSlot(slot);
    }

    try {
      await runAgentLoop({
        brainId: this.id,
        provider: this.provider,
        tools: this.tools,
        contextEngine: this.contextEngine,
        sessionHistory: this.sessionHistory,
        modelSpec: this.modelSpec,
        maxIterations: 20,
        signal,
        brainBoard: this.brainBoard,
        slotRegistry: this.slotRegistry,
        pathManager: this.pathManager,
        terminalManager: this.terminalManager,
        workspace: this.workspace,
        emit: this.emitFn,
        logger: this.logger,
        sessionManager: this.sessionManager,
        turn: this.currentTurn,
      });
    } finally {
      for (const slot of eventSlots) {
        this.slotRegistry.removeSlot(slot.id);
      }
    }

    const keepToolResults = this.brainConfig.session?.keepToolResults ?? 8;
    microCompact(this.sessionHistory, keepToolResults);
  }

  // ─── Lifecycle: 3 levels ───

  stop(): void {
    this.turnAbort?.abort();
    this.brainBoard.set(this.id, "status", "stopped");
    this.logger.info(this.id, this.currentTurn, "stop() called — aborting current LLM call");
  }

  async shutdown(): Promise<void> {
    this.stop();

    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }

    this.slotRegistry.clear();
    this.eventBus.unregister(this.id);

    await this.sessionManager.appendMessage({
      role: "assistant",
      content: "[session ended — shutdown]",
      ts: Date.now(),
    });

    this.brainBoard.set(this.id, "status", "shutdown");
    this.logger.info(this.id, this.currentTurn, "shutdown() complete");
  }

  async free(): Promise<void> {
    await this.shutdown();

    this.brainBoard.remove(this.id, "status");
    this.brainBoard.remove(this.id, "currentTurn");
    this.brainBoard.remove(this.id, "lastActivity");
    this.brainBoard.remove(this.id, "model.name");
    this.brainBoard.remove(this.id, "model.contextWindow");
    this.brainBoard.remove(this.id, "tokens.lastInputTokens");
    this.brainBoard.remove(this.id, "tokens.lastOutputTokens");
    this.brainBoard.remove(this.id, "tokens.totalIn");
    this.brainBoard.remove(this.id, "tokens.totalOut");

    this.emitFn({
      source: `brain:${this.id}`,
      type: "brain_freed",
      payload: { brainId: this.id },
      ts: Date.now(),
      silent: true,
    });

    this.logger.info(this.id, this.currentTurn, "free() complete — brainBoard entries deleted");
  }
}

// ─── Signal combinators ───

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ac = new AbortController();
  const abort = () => ac.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return ac.signal;
}
