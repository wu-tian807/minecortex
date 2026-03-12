/** @desc ConsciousBrain — streaming agent loop with handoff-aware scheduling */

import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
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
import { createFallbackProvider, getModelSpec, mergeModelsConfig } from "../llm/provider.js";
import type { ModelsConfig } from "./types.js";
import { ContextEngine } from "../context/context-engine.js";
import { SlotRegistry } from "../registries/slot-registry.js";
import { SessionManager } from "../session/session-manager.js";
import { assembleResponseWithCallback } from "../llm/stream.js";
import { renderEventDisplay } from "../context/event-router.js";
import { HookEvent } from "../hooks/types.js";
import { runToolBatch } from "./tool-batch-runner.js";
import { BaseBrain } from "./base-brain.js";
import { runWithLogContext } from "./logger.js";
import { BRAIN_DEFAULTS } from "../defaults/brain-defaults.js";
import {
  BRAINBOARD_KEYS,
  createCurrentDirPathManager,
  buildBuiltinBrainBoardVars,
  resolveBrainDefaultDir,
} from "../defaults/brainboard-vars.js";
import { ToolRegistry } from "../registries/tool-registry.js";
import { ToolLoader } from "../loaders/tool-loader.js";
import { SlotLoader } from "../loaders/slot-loader.js";
import { SubscriptionLoader } from "../loaders/subscription-loader.js";
import { BaseLoader } from "../loaders/base-loader.js";
import { SubscriptionRegistry } from "../registries/subscription-registry.js";
import { readBrainDotEnv } from "../terminal/env-builder.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Reusable agent loop (persistent session backed) ───

export interface AgentLoopOpts {
  brainId: string;
  getBrainJson: () => BrainJson;
  provider: LLMProvider;
  getTools: () => ToolDefinition[];
  dynamicTools: DynamicToolAPI;
  dynamicSubscriptions: DynamicSubscriptionAPI;
  contextEngine: ContextEngine;
  modelSpec: ModelSpec;
  maxIterations: number;
  signal: AbortSignal;
  brainBoard: import("./types.js").BrainBoardAPI;
  slotRegistry: DynamicSlotAPI;
  pathManager: import("./types.js").PathManagerAPI;
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
  shouldYieldInnerLoop?: () => boolean;
  timezone?: string;
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<LLMResponse | null> {
  return await runWithLogContext({ brainId: opts.brainId, turn: opts.turn ?? 0 }, async () => {
    const {
      brainId, provider, getTools, dynamicTools, dynamicSubscriptions, contextEngine,
      modelSpec, maxIterations, signal, brainBoard, slotRegistry,
      pathManager, eventBus, logger,
      sessionManager, turn = 0, onAssistantMessage, hooks,
      keepToolResults = 8, keepMedias = 2, showThinking = false,
      shouldYieldInnerLoop,
    } = opts;

    const lifecycle = sessionManager;
    let iterations = 0;
    let lastResponse: LLMResponse | null = null;

    const toolCtx: ToolContext = {
      brainId,
      brainDir: pathManager.local(brainId).root(),
      signal,
      eventBus,
      brainBoard,
      env: {},
      getBrainJson: opts.getBrainJson,
      hooks,
      queueCommand: undefined,
      slot: slotRegistry,
      tools: dynamicTools,
      subscriptions: dynamicSubscriptions,
      pathManager: createCurrentDirPathManager(pathManager, brainBoard, brainId),
      sessionManager,
    };

    for (;;) {
      if (signal.aborted || (maxIterations != -1 && iterations >= maxIterations) ) break;
      iterations++;
      toolCtx.env = await readBrainDotEnv(brainId, pathManager);

      const sessionHistory = await sessionManager.loadPromptHistory({ keepToolResults, keepMedias });

      const tz = opts.timezone ?? "Asia/Shanghai";
      brainBoard.set(
        brainId,
        BRAINBOARD_KEYS.CURRENT_TIME,
        new Date().toLocaleString("zh-CN", { timeZone: tz }),
        { persist: false },
      );

      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(brainBoard.getAll(brainId))) {
        vars[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
      const messages = contextEngine.assemblePrompt(
        sessionHistory,
        modelSpec,
        undefined,
        vars,
      );
      const tools = getTools();

      logger?.debug(brainId, turn,
        `LLM call: ${messages.length} msgs, ${tools.length} tools, session=${sessionHistory.length}`);

      // Track partial text/thinking via onChunk so that on non-abort errors we
      // can still emit a truncated AssistantMessage before surfacing the error.
      let partialText = "";
      let partialThinking = "";

      let response: LLMResponse;
      try {
        const stream = provider.chatStream(messages, tools, signal);
        response = await assembleResponseWithCallback(stream, (chunk) => {
          if (chunk.type === "text") partialText += chunk.text;
          if (chunk.type === "thinking") partialThinking += chunk.text;
          hooks?.emit(HookEvent.StreamChunk, { chunk, turn });
        });
      } catch (err: any) {
        if (signal.aborted) {
          logger?.warn(brainId, turn, "LLM call aborted");
          break;
        }
        logger?.error(brainId, turn, `LLM call failed: ${err.message}`);
        // If partial output was generated before the error, persist and surface it.
        if (partialText.trim() || partialThinking.trim()) {
          const partialMsg: LLMMessage = {
            role: "assistant",
            content: partialText,
            thinking: partialThinking || undefined,
            truncated: true,
            ts: Date.now(),
          };
          await lifecycle.appendAssistantTurn(partialMsg);
          hooks?.emit(HookEvent.AssistantMessage, { msg: partialMsg, turn });
        }
        // Re-throw so process() can capture the error and include it in TurnEnd.
        throw err;
      }

      // assembleResponseWithCallback returns truncated:true when abort fires mid-stream.
      if (response.truncated) {
        logger?.warn(brainId, turn, "LLM stream aborted mid-flight; saving partial response");
        const raw = typeof response.content === "string" ? response.content : "";
        if (raw.trim() || response.thinking?.trim()) {
          const partialMsg: LLMMessage = {
            role: "assistant",
            content: raw,
            thinking: response.thinking,
            truncated: true,
            ts: Date.now(),
          };
          await lifecycle.appendAssistantTurn(partialMsg);
          hooks?.emit(HookEvent.AssistantMessage, { msg: partialMsg, turn });
        }
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
        // Stream completed but signal was aborted before we could process tool calls.
        // Persist and emit the partial message so it's visible in the UI.
        assistantMsg.truncated = true;
        await lifecycle.appendAssistantTurn(assistantMsg);
        hooks?.emit(HookEvent.AssistantMessage, { msg: assistantMsg, turn });
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
  /** Global model defaults from minecortex.json — brain.json.models overrides these at call time. */
  globalModels: ModelsConfig;
}

// ─── ConsciousBrain ───

export class ConsciousBrain extends BaseBrain {
  private readonly provider: LLMProvider;
  private tools: ToolDefinition[] = [];
  private readonly toolRegistry: ToolRegistry;
  private readonly subscriptionRegistry: SubscriptionRegistry;
  private readonly slotRegistry: SlotRegistry;
  private readonly contextEngine: ContextEngine;
  private readonly sessionManager: SessionManager;
  private readonly toolLoader: ToolLoader;
  private readonly slotLoader: SlotLoader;
  private readonly subscriptionLoader: SubscriptionLoader;
  private currentTurn = 0;
  private turnAbort: AbortController | null = null;
  private commandQueue: Array<{ toolName: string; args: Record<string, string>; reason?: string }> = [];
  private readonly globalModels: ModelsConfig;
  private capabilitiesInitialized = false;

  constructor(config: ConsciousBrainInitConfig) {
    super(config);
    this.globalModels = config.globalModels;

    // Stateless provider — reads fresh ModelsConfig on every chatStream call.
    this.provider = createFallbackProvider(() => mergeModelsConfig(this.globalModels, this.brainJson.models ?? {}));

    // Hot-reload brain.json via fs.watch (no per-turn disk read needed).
    const brainJsonPath = join(this.brainDir, "brain.json");
    const watcher = fsWatch(brainJsonPath, () => {
      readFile(brainJsonPath, "utf-8")
        .then(raw => {
          this.brainJson = JSON.parse(raw) as BrainJson;
          if (!this.capabilitiesInitialized) return;
          return this.reloadConfigDrivenCapabilities();
        })
        .catch((err) => {
          this.logger.warn(this.id, 0, `brain.json reload ignored: ${err?.message ?? err}`);
        });
    });
    this.abortController.signal.addEventListener("abort", () => watcher.close(), { once: true });

    this.toolRegistry = new ToolRegistry();
    this.subscriptionRegistry = new SubscriptionRegistry();
    this.slotRegistry = new SlotRegistry();
    this.contextEngine = new ContextEngine(this.slotRegistry);
    this.sessionManager = new SessionManager(this.id, this.pathManager);
    this.toolLoader = new ToolLoader();
    this.slotLoader = new SlotLoader();
    this.subscriptionLoader = new SubscriptionLoader();

    this.toolLoader.setLogContext(this.id);
    this.toolLoader.setCallback((tools) => this.toolRegistry.replaceStatic(tools));
    this.toolRegistry.setOnChange((tools) => this.updateTools(tools));

    this.slotLoader.setLogContext(this.id);
    this.slotLoader.setSlotContext({
      brainId: this.id,
      brainDir: this.brainDir,
      signal: this.abortController.signal,
      eventBus: this.boundEventBus,
      brainBoard: this.brainBoard,
      pathManager: this.pathManager,
      env: {},
      getBrainJson: () => this.brainJson,
      hooks: this.hooks,
      queueCommand: (toolName, args, reason) => this.queueCommand(toolName, args, reason),
      sessionManager: this.sessionManager,
      slot: this.slotRegistry,
      tools: this.toolRegistry,
      subscriptions: this.subscriptionRegistry,
    });
    this.slotLoader.setCallbacks(
      (slots) => { for (const slot of slots) this.slotRegistry.registerStatic(slot); },
      (names) => { for (const name of names) this.slotRegistry.releaseStatic(name); },
    );

    this.subscriptionLoader.setLogContext(this.id);
    this.subscriptionLoader.setEmitter((event) => this.pushEvent(event));
    this.subscriptionLoader.setBrainContext({
      brainId: this.id,
      brainDir: this.brainDir,
      signal: this.abortController.signal,
      hooks: this.hooks,
      brainBoard: this.brainBoard,
      pathManager: this.pathManager,
      eventBus: this.boundEventBus,
      env: {},
      getBrainJson: () => this.brainJson,
      queueCommand: (toolName, args, reason) => this.queueCommand(toolName, args, reason),
      sessionManager: this.sessionManager,
      slot: this.slotRegistry,
      tools: this.toolRegistry,
      subscriptions: this.subscriptionRegistry,
    });
    this.subscriptionLoader.setCallback((sources) => this.subscriptionRegistry.replaceStatic(sources));
    this.subscriptionRegistry.setEmitter((event) => this.pushEvent(event));

    // ─── Built-in brainBoard vars ────────────────────────────────────────────
    //
    //   persisted  — survive process restarts (written to brainboard.json)
    //     • currentContextUsage: inputTokens + outputTokens for the current session
    //
    //   memory (persist: false) — in-process only, injected into every prompt turn
    //     • BRAIN_ID:    identity of this brain
    //     • BRAIN_DIR:   absolute path to this brain's directory
    //     • CURRENT_TIME: wall-clock time, refreshed at the start of each agent loop iteration

    const builtinVars = buildBuiltinBrainBoardVars(
      this.id,
      config.brainDir,
      this.pathManager,
    );
    for (const [key, value] of Object.entries(builtinVars)) {
      this.brainBoard.set(this.id, key, value, { persist: false });
    }
    if (this.brainBoard.get(this.id, BRAINBOARD_KEYS.CURRENT_DIR) == null) {
      this.brainBoard.set(
        this.id,
        BRAINBOARD_KEYS.CURRENT_DIR,
        resolveBrainDefaultDir(this.id, this.brainJson, this.pathManager),
        { persist: false },
      );
    }

    this.sessionManager.setCallbacks({
      onSessionSwitch: (_newSid, lastContextUsage) => {
        if (lastContextUsage !== null) {
          this.brainBoard.set(this.id, BRAINBOARD_KEYS.CURRENT_CONTEXT_USAGE, lastContextUsage);
        } else {
          this.brainBoard.remove(this.id, BRAINBOARD_KEYS.CURRENT_CONTEXT_USAGE);
        }
      },
      onContextUsageChange: (_sessionId, usage) => {
        this.brainBoard.set(this.id, BRAINBOARD_KEYS.CURRENT_CONTEXT_USAGE, usage);
      },
    });
  }

  async initCapabilities(): Promise<void> {
    const existingSid = await this.sessionManager.currentSessionId();
    if (!existingSid) {
      await this.sessionManager.createSession();
    }

    if (this.fsWatcher) {
      this.toolLoader.registerWatchPatterns(this.fsWatcher, this.id);
      this.slotLoader.registerWatchPatterns(this.fsWatcher, this.id);
      this.subscriptionLoader.registerWatchPatterns(this.fsWatcher, this.id);
    }

    await this.reloadConfigDrivenCapabilities();
    this.capabilitiesInitialized = true;
  }

  updateTools(tools: ToolDefinition[]): void {
    this.tools = tools;
    this.brainBoard.set(this.id, BRAINBOARD_KEYS.ACTIVE_TOOLS, tools.map((t) => ({
      name: t.name,
      description: t.description,
      guidance: t.guidance,
      input_schema: t.input_schema,
    })), { persist: false });
    this.logger.info(this.id, 0, `tools reloaded: ${tools.length} total`);
  }

  private async reloadConfigDrivenCapabilities(): Promise<void> {
    await this.toolLoader.load({
      brainId: this.id,
      brainDir: this.brainDir,
      pathManager: this.pathManager,
      selector: this.brainJson.tools ?? BRAIN_DEFAULTS.tools,
      capabilitySources: BaseLoader.buildSources(
        this.pathManager,
        this.id,
        "tools",
      ),
    });
    await this.slotLoader.load({
      brainId: this.id,
      brainDir: this.brainDir,
      pathManager: this.pathManager,
      selector: this.brainJson.slots ?? BRAIN_DEFAULTS.slots,
      capabilitySources: BaseLoader.buildSources(
        this.pathManager,
        this.id,
        "slots",
      ),
    });
    await this.subscriptionLoader.load({
      brainId: this.id,
      brainDir: this.brainDir,
      pathManager: this.pathManager,
      selector: this.brainJson.subscriptions ?? BRAIN_DEFAULTS.subscriptions,
      capabilitySources: BaseLoader.buildSources(
        this.pathManager,
        this.id,
        "subscriptions",
      ),
    });
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

    const lines = events.map(e => {
      const display = renderEventDisplay(e);
      return display ? `[${e.source}:${e.type}] ${display}` : `[${e.source}:${e.type}]`;
    });
    await this.sessionManager.appendMessage({
      role: "user",
      content: lines.join("\n"),
      ts: Date.now(),
    });

    this.hooks.emit(HookEvent.TurnStart, { turn: this.currentTurn, eventCount: events.length });
    let aborted = false;
    let turnError: string | undefined;

    try {
      const mc = mergeModelsConfig(this.globalModels, this.brainJson.models ?? {});
      const currentModel = Array.isArray(mc.model) ? mc.model[0] : (mc.model ?? "");
      await runAgentLoop({
        brainId: this.id,
        getBrainJson: () => this.brainJson,
        provider: this.provider,
        getTools: () => this.tools,
        dynamicTools: this.toolRegistry,
        dynamicSubscriptions: this.subscriptionRegistry,
        contextEngine: this.contextEngine,
        modelSpec: getModelSpec(currentModel),
        maxIterations: this.brainJson.maxIterations ?? BRAIN_DEFAULTS.maxIterations,
        signal,
        brainBoard: this.brainBoard,
        slotRegistry: this.slotRegistry,
        pathManager: this.pathManager,
        eventBus: this.boundEventBus,
        logger: this.logger,
        sessionManager: this.sessionManager,
        turn: this.currentTurn,
        hooks: this.hooks,
        keepToolResults: this.brainJson.session?.keepToolResults ?? BRAIN_DEFAULTS.session.keepToolResults,
        keepMedias: this.brainJson.session?.keepMedias ?? BRAIN_DEFAULTS.session.keepMedias,
        showThinking: this.brainJson.models?.showThinking ?? true,
        shouldYieldInnerLoop: () => this.queue.hasHandoff("innerLoop"),
        timezone: this.brainJson.timezone,
      });
    } catch (err: any) {
      aborted = signal.aborted;
      if (!aborted) {
        turnError = err?.message ?? String(err);
        this.logger.error(this.id, this.currentTurn, `process failed: ${turnError}`);
      }
    } finally {
      this.hooks.emit(HookEvent.TurnEnd, { turn: this.currentTurn, aborted, error: turnError });
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
      brainDir: this.brainDir,
      signal,
      eventBus: this.boundEventBus,
      brainBoard: this.brainBoard,
      env: await readBrainDotEnv(this.id, this.pathManager),
      getBrainJson: () => this.brainJson,
      hooks: this.hooks,
      queueCommand: (toolName, args, reason) => this.queueCommand(toolName, args, reason),
      slot: this.slotRegistry,
      tools: this.toolRegistry,
      subscriptions: this.subscriptionRegistry,
      pathManager: createCurrentDirPathManager(this.pathManager, this.brainBoard, this.id),
      sessionManager: this.sessionManager,
    };

    this.hooks.emit(HookEvent.TurnStart, { turn: this.currentTurn, eventCount: 1 });
    let aborted = false;
    let results: Awaited<ReturnType<typeof runToolBatch>>;
    try {
      results = await runToolBatch({
        toolCalls: [toolCall],
        tools: this.tools,
        toolCtx,
        lifecycle: this.sessionManager,
        logger: this.logger,
        hooks: this.hooks,
        turn: this.currentTurn,
      });
    } catch (err: any) {
      aborted = signal.aborted;
      if (!aborted) this.logger.error(this.id, this.currentTurn, `command failed: ${err?.message ?? err}`);
      return;
    } finally {
      this.hooks.emit(HookEvent.TurnEnd, { turn: this.currentTurn, aborted });
    }

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

  // ─── Lifecycle: 3 levels ───

  override stop(): void {
    this.turnAbort?.abort();
    this.logger.info(this.id, this.currentTurn, "stop() called — aborting current LLM call");
  }

  override async shutdown(): Promise<void> {
    this.stop();
    this.abortController.abort();

    await super.shutdown();
    this.toolRegistry.clear();
    this.subscriptionRegistry.clear();
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
