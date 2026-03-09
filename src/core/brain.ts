/** @desc ConsciousBrain — streaming agent loop with handoff-aware scheduling */

import type {
  BrainInitConfig,
  BrainJson,
  Event,
  EventBusAPI,
  ToolDefinition,
  ToolContext,
  DynamicSlotAPI,
  DynamicToolAPI,
  DynamicSubscriptionAPI,
  ModelSpec,
} from "./types.js";
import type { LLMProvider, LLMMessage, LLMToolCall, LLMResponse } from "../llm/types.js";
import type { ContextEngine } from "../context/context-engine.js";
import type { SlotRegistry } from "../context/slot-registry.js";
import type { SessionManager } from "../session/session-manager.js";
import { assembleResponseWithCallback } from "../llm/stream.js";
import { renderEventDisplay } from "../context/event-router.js";
import { HookEvent } from "../hooks/types.js";
import { runToolBatch } from "./tool-batch-runner.js";
import { BaseBrain } from "./base-brain.js";
import { runWithLogContext } from "./logger.js";
import { BRAIN_DEFAULTS } from "../defaults/brain-defaults.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Reusable agent loop (persistent session backed) ───

export interface AgentLoopOpts {
  brainId: string;
  provider: LLMProvider;
  tools: ToolDefinition[];
  dynamicTools: DynamicToolAPI;
  dynamicSubscriptions: DynamicSubscriptionAPI;
  contextEngine: ContextEngine;
  modelSpec: ModelSpec;
  maxIterations: number;
  signal: AbortSignal;
  brainBoard: import("./types.js").BrainBoardAPI;
  slotRegistry: DynamicSlotAPI;
  pathManager: import("./types.js").PathManagerAPI;
  workspace: string;
  eventBus: EventBusAPI;
  logger?: import("./logger.js").Logger;
  /** Persistent session — history is reloaded from disk each iteration. */
  sessionManager: SessionManager;
  turn?: number;
  onAssistantMessage?: (msg: LLMMessage) => void;
  hooks?: import("../hooks/brain-hooks.js").BrainHooks;
  keepToolResults?: number;
  keepMedias?: number;
  showThinking?: boolean;
  trackBackgroundTask?: (p: Promise<unknown>) => void;
  shouldYieldInnerLoop?: () => boolean;
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<LLMResponse | null> {
  return await runWithLogContext({ brainId: opts.brainId, turn: opts.turn ?? 0 }, async () => {
    const {
      brainId, provider, tools, dynamicTools, dynamicSubscriptions, contextEngine,
      modelSpec, maxIterations, signal, brainBoard, slotRegistry,
      pathManager, workspace, eventBus, logger,
      sessionManager, turn = 0, onAssistantMessage, hooks,
      keepToolResults = 8, keepMedias = 2, showThinking = false,
      shouldYieldInnerLoop,
    } = opts;

    const lifecycle = sessionManager;
    let iterations = 0;
    let lastResponse: LLMResponse | null = null;

    const toolCtx: ToolContext = {
      brainId,
      signal,
      eventBus,
      brainBoard,
      slot: slotRegistry,
      tools: dynamicTools,
      subscriptions: dynamicSubscriptions,
      pathManager,
      workspace,
      sessionManager,
      trackBackgroundTask: opts.trackBackgroundTask,
      logger,
    };

    for (;;) {
      if (signal.aborted || (maxIterations != -1 && iterations >= maxIterations) ) break;
      iterations++;

      const sessionHistory = await sessionManager.loadPromptHistory({ keepToolResults, keepMedias });

      const boardEntries = brainBoard.getAll(brainId);
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(boardEntries)) {
        vars[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
      vars.BRAIN_ID = brainId;
      vars.BRAIN_DIR = pathManager.resolve({ path: "." }, brainId);
      const tz = (brainBoard.get(brainId, "timezone") as string) ?? "Asia/Shanghai";
      vars.CURRENT_TIME = new Date().toLocaleString("zh-CN", { timeZone: tz });
      const messages = contextEngine.assemblePrompt(
        sessionHistory,
        modelSpec,
        undefined,
        vars,
      );

      logger?.debug(brainId, turn,
        `LLM call: ${messages.length} msgs, ${tools.length} tools, session=${sessionHistory.length}`);

      let response: LLMResponse;
      try {
        const stream = provider.chatStream(messages, tools, signal);
        response = await assembleResponseWithCallback(stream, (chunk) => {
          hooks?.emit(HookEvent.StreamChunk, { chunk, turn });
        });
      } catch (err: any) {
        if (signal.aborted) {
          logger?.warn(brainId, turn, "LLM call aborted");
          break;
        }
        logger?.error(brainId, turn, `LLM call failed: ${err.message}`);

        const errorText = `[LLM error: ${err.message?.slice(0, 200) ?? "unknown"}]`;
        await lifecycle.appendAssistantTurn({
          role: "assistant",
          content: errorText,
          ts: Date.now(),
        });
        hooks?.emit(HookEvent.AssistantMessage, {
          msg: { role: "assistant", content: errorText },
          turn,
        });
        break;
      }

      logger?.debug(brainId, turn,
        `LLM response: content=${typeof response.content === "string" ? response.content.length : "multimodal"} chars, tools=${response.toolCalls?.length ?? 0}`);

      lastResponse = response;

      // currentContextUsage is updated via SessionStore.onContextUsageChange, which fires
      // inside appendAssistantTurn (below) whenever the assistant message carries usage data.
      // No manual brainBoard write needed here.

      let content = response.content;
      const hasThinking = showThinking && response.thinking;
      if (hasThinking) {
        const thinkingBlock = `<thinking>${response.thinking}</thinking>`;
        if (typeof content === "string") {
          content = content ? `${thinkingBlock}\n${content}` : thinkingBlock;
        }
      }

      const assistantMsg: LLMMessage = {
        role: "assistant",
        content,
        thinking: hasThinking ? response.thinking : undefined,
        thinkingSignature: hasThinking ? response.thinkingSignature : undefined,
        textSignature: response.textSignature,
        toolCalls: response.toolCalls,
        usage: response.usage
          ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
          : undefined,
        ts: Date.now(),
      };

      if (signal.aborted) {
        assistantMsg.truncated = true;
        await lifecycle.appendAssistantTurn(assistantMsg);
        break;
      }

      await lifecycle.appendAssistantTurn(assistantMsg);

      hooks?.emit(HookEvent.AssistantMessage, { msg: assistantMsg, turn });
      onAssistantMessage?.(assistantMsg);

      const textContent = typeof content === "string" ? content : "";
      const displayContent = textContent.replace(/<thinking>[\s\S]*?<\/thinking>\n?/, "").trim();
      if (displayContent) {
        logger?.info(brainId, turn, displayContent);
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (!displayContent) {
          logger?.warn(brainId, turn, "LLM returned empty response (no content, no tool calls)");
        }
        break;
      }

      await runToolBatch({
        toolCalls: response.toolCalls,
        tools,
        toolCtx,
        lifecycle,
        logger,
        hooks,
        turn,
      });

      if (shouldYieldInnerLoop?.()) {
        logger?.debug(brainId, turn, "yielding current turn after inner loop boundary");
        break;
      }
    }

    return lastResponse;
  });
}

// ─── ConsciousBrain-specific init config ───

export interface ConsciousBrainInitConfig extends BrainInitConfig {
  model: string;
  provider: LLMProvider;
  tools: ToolDefinition[];
  dynamicTools: DynamicToolAPI;
  dynamicSubscriptions: DynamicSubscriptionAPI;
  slotRegistry: SlotRegistry;
  contextEngine: ContextEngine;
  sessionManager: SessionManager;
  modelSpec: ModelSpec;
  workspace: string;
}

// ─── ConsciousBrain ───

export class ConsciousBrain extends BaseBrain {
  private provider: LLMProvider;
  private tools: ToolDefinition[];
  private dynamicTools: DynamicToolAPI;
  private dynamicSubscriptions: DynamicSubscriptionAPI;
  private slotRegistry: SlotRegistry;
  private contextEngine: ContextEngine;
  private sessionManager: SessionManager;
  private modelSpec: ModelSpec;
  private workspace: string;
  private currentTurn = 0;
  private turnAbort: AbortController | null = null;
  private pendingTasks = new Set<Promise<unknown>>();
  private commandQueue: Array<{ toolName: string; args: Record<string, string>; reason?: string }> = [];

  constructor(config: ConsciousBrainInitConfig) {
    super(config);
    this.provider = config.provider;
    this.tools = config.tools;
    this.dynamicTools = config.dynamicTools;
    this.dynamicSubscriptions = config.dynamicSubscriptions;
    this.slotRegistry = config.slotRegistry;
    this.contextEngine = config.contextEngine;
    this.sessionManager = config.sessionManager;
    this.modelSpec = config.modelSpec;
    this.workspace = config.workspace;

    // ─── Built-in brainBoard vars ────────────────────────────────────────────
    //
    // Two tiers, both wired up here so the session layer stays free of any
    // brainBoard / token-accounting knowledge:
    //
    //   persisted  — survive process restarts (written to brainboard.json)
    //     • currentContextUsage: inputTokens + outputTokens for the current session
    //
    //   memory     — in-process only (persist: false)
    //     • currentSessionId: lets the renderer validate its ring subscription

    this.sessionManager.setCallbacks({
      onSessionSwitch: (_newSid, lastContextUsage) => {
        if (lastContextUsage !== null) {
          this.brainBoard.set(this.id, "currentContextUsage", lastContextUsage);
        } else {
          this.brainBoard.remove(this.id, "currentContextUsage");
        }
      },
      onContextUsageChange: (_sessionId, usage) => {
        this.brainBoard.set(this.id, "currentContextUsage", usage);
      },
    });
  }

  updateTools(tools: ToolDefinition[]): void {
    this.tools = tools;
    this.logger.info(this.id, 0, `tools reloaded: ${tools.length} total`);
  }

  setDynamicSubscriptions(api: DynamicSubscriptionAPI): void {
    this.dynamicSubscriptions = api;
  }

  protected async runMain(_signal: AbortSignal): Promise<void> {
    // Start event sources
    this.startSources();

    while (!this.signal.aborted) {
      // Process any queued commands first (from stdin /xxx or auto_compact)
      while (this.commandQueue.length > 0 && !this.signal.aborted) {
        const cmd = this.commandQueue.shift()!;
        this.currentTurn++;
        this.turnAbort = new AbortController();
        const combinedSignal = combineSignals(this.signal, this.turnAbort.signal);
        try {
          await this.withLogContext(async () => {
            await this.executeCommand(cmd.toolName, cmd.args, cmd.reason, combinedSignal);
          }, this.currentTurn);
        } catch (err: any) {
          if (!combinedSignal.aborted) {
            this.logger.error(this.id, this.currentTurn, "command failed", err);
          }
        } finally {
          this.turnAbort = null;
        }
      }

      let trigger: Event;
      try {
        trigger = await this.queue.waitForEvent(this.signal);
      } catch {
        break;
      }

      if (this.queue.hasHandoff("steer")) {
        // Skip coalesce for steer events — process immediately
      } else if ((trigger.priority ?? 1) > 0 && this.coalesceMs > 0) {
        await sleep(this.coalesceMs);
      }

      const events = this.queue.drain().filter(e => e.source !== "_system");
      if (events.length === 0) continue;

      this.currentTurn++;
      this.turnAbort = new AbortController();
      const combinedSignal = combineSignals(this.signal, this.turnAbort.signal);

      const steerWatcher = this.queue.onSteer(() => {
        this.turnAbort?.abort();
      });

      this.logger.info(this.id, this.currentTurn, `▶ process [${events.length} events]`);

      try {
        await this.withLogContext(async () => {
          await this.process(events, combinedSignal);
        }, this.currentTurn);
      } catch (err: any) {
        if (combinedSignal.aborted) {
          this.logger.warn(this.id, this.currentTurn, "turn aborted");
        } else {
          this.logger.error(this.id, this.currentTurn, "process failed", err);
        }
      } finally {
        steerWatcher.dispose();
        this.turnAbort = null;
      }
    }
  }

  private async process(events: Event[], signal: AbortSignal): Promise<void> {
    if (events.length === 0) return;

    // Emit EventReceived hook before processing
    this.hooks.emit(HookEvent.EventReceived, { events, turn: this.currentTurn });

    const lines = events.map(e =>
      `[${e.source}:${e.type}] ${renderEventDisplay(e)}`
    );
    await this.sessionManager.appendMessage({
      role: "user",
      content: lines.join("\n"),
      ts: Date.now(),
    });

    this.hooks.emit(HookEvent.TurnStart, { turn: this.currentTurn, eventCount: events.length });
    let aborted = false;

    try {
      await runAgentLoop({
        brainId: this.id,
        provider: this.provider,
        tools: this.tools,
        dynamicTools: this.dynamicTools,
        dynamicSubscriptions: this.dynamicSubscriptions,
        contextEngine: this.contextEngine,
        modelSpec: this.modelSpec,
        maxIterations: this.brainJson.maxIterations ?? BRAIN_DEFAULTS.maxIterations,
        signal,
        brainBoard: this.brainBoard,
        slotRegistry: this.slotRegistry,
        pathManager: this.pathManager,
        workspace: this.workspace,
        eventBus: this.boundEventBus,
        logger: this.logger,
        sessionManager: this.sessionManager,
        turn: this.currentTurn,
        hooks: this.hooks,
        keepToolResults: this.brainJson.session?.keepToolResults ?? BRAIN_DEFAULTS.session.keepToolResults,
        keepMedias: this.brainJson.session?.keepMedias ?? BRAIN_DEFAULTS.session.keepMedias,
        showThinking: this.brainJson.models?.showThinking ?? true,
        trackBackgroundTask: (p) => {
          this.pendingTasks.add(p);
          p.finally(() => this.pendingTasks.delete(p));
        },
        shouldYieldInnerLoop: () => this.queue.hasHandoff("innerLoop"),
      });
    } catch (err: any) {
      aborted = signal.aborted;
      if (!aborted) {
        this.logger.error(this.id, this.currentTurn, `process failed: ${err?.message ?? err}`);
      }
    } finally {
      this.hooks.emit(HookEvent.TurnEnd, { turn: this.currentTurn, aborted });
    }
  }

  private async executeCommand(
    toolName: string, args: Record<string, string>, reason: string | undefined, signal: AbortSignal,
  ): Promise<void> {
    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) {
      this.logger.warn(this.id, this.currentTurn, `command: unknown tool '${toolName}'`);
      return;
    }

    const callId = `cmd_${Date.now()}`;
    const toolCall: LLMToolCall = { id: callId, name: toolName, arguments: args };

    await this.sessionManager.appendMessage({
      role: "user",
      content: `[command] ${reason ?? toolName}`,
      ts: Date.now(),
    });

    const assistantMsg: LLMMessage = {
      role: "assistant",
      content: reason ?? `Executing: ${toolName}`,
      toolCalls: [toolCall],
      ts: Date.now(),
    };
    await this.sessionManager.appendAssistantTurn(assistantMsg);

    const toolCtx: ToolContext = {
      brainId: this.id,
      signal,
      eventBus: this.boundEventBus,
      brainBoard: this.brainBoard,
      slot: this.slotRegistry,
      tools: this.dynamicTools,
      subscriptions: this.dynamicSubscriptions,
      pathManager: this.pathManager,
      workspace: this.workspace,
      sessionManager: this.sessionManager,
      trackBackgroundTask: (p) => {
        this.pendingTasks.add(p);
        p.finally(() => this.pendingTasks.delete(p));
      },
      logger: this.logger,
    };

    const results = await runToolBatch({
      toolCalls: [toolCall],
      tools: this.tools,
      toolCtx,
      lifecycle: this.sessionManager,
      logger: this.logger,
      hooks: this.hooks,
      turn: this.currentTurn,
    });

    const result = results[0]?.result;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    this.logger.info(this.id, this.currentTurn, `command /${toolName} → ${resultStr.slice(0, 200)}`);
  }

  queueCommand(toolName: string, args: Record<string, string>, reason?: string): void {
    this.commandQueue.push({ toolName, args, reason });
    if (this.turnAbort) {
      this.turnAbort.abort();
    } else {
      this.eventBus.nudge(this.id);
    }
  }

  /** Hot-swap provider/model when brain.json changes. Takes effect on next turn. */
  updateConfig(opts: { provider: LLMProvider; modelSpec: ModelSpec; brainConfig: BrainJson }) {
    this.provider = opts.provider;
    this.modelSpec = opts.modelSpec;
    this.brainJson = opts.brainConfig;
  }

  // ─── Lifecycle: 3 levels ───

  override stop(): void {
    this.turnAbort?.abort();
    this.logger.info(this.id, this.currentTurn, "stop() called — aborting current LLM call");
  }

  override async shutdown(): Promise<void> {
    this.stop();
    this.abortController.abort();

    if (this.pendingTasks.size > 0) {
      this.logger.info(this.id, this.currentTurn, `awaiting ${this.pendingTasks.size} background task(s)...`);
      const timeout = new Promise<void>(r => setTimeout(r, 5000));
      await Promise.race([Promise.allSettled([...this.pendingTasks]), timeout]);
      this.pendingTasks.clear();
    }

    await super.shutdown();
    this.slotRegistry.clear();

    this.logger.info(this.id, this.currentTurn, "shutdown() complete");
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
