/** @desc Scheduler — singleton managers, brain discovery, ScriptBrain support, shutdown handling */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type {
  BrainInterface,
  BrainJson,
  MineclawConfig,
  Event,
  EventSource,
} from "./types.js";
import { EventBus } from "./event-bus.js";
import { EventQueue } from "./event-queue.js";
import { BrainBoard } from "./brain-board.js";
import { ConsciousBrain } from "./brain.js";
import { ScriptBrain } from "./script-brain.js";
import { ToolLoader } from "../loaders/tool-loader.js";
import { SubscriptionLoader } from "../loaders/subscription-loader.js";
import { SlotLoader } from "../loaders/slot-loader.js";
import { ContextEngine } from "../context/context-engine.js";
import { SlotRegistry } from "../context/slot-registry.js";
import { PathManager } from "../fs/path-manager.js";
import { FSWatcher } from "../fs/watcher.js";
import { TerminalManager } from "../terminal/manager.js";
import { SessionManager } from "../session/session-manager.js";
import { Logger } from "./logger.js";
import { createProvider, createFallbackProvider, getModelSpec } from "../llm/provider.js";

const ROOT = process.cwd();

interface BrainSlot {
  brain: BrainInterface & { stop?(): void; shutdown?(): Promise<void>; free?(): Promise<void> };
  queue: EventQueue;
  abortController: AbortController;
  sources: EventSource[];
}

export class Scheduler {
  private eventBus = new EventBus();
  private brainBoard = new BrainBoard();
  private pathManager = new PathManager(ROOT);
  private terminalManager = new TerminalManager(this.pathManager);
  private logger = new Logger(ROOT);
  private fsWatcher: FSWatcher | null = null;
  private slots = new Map<string, BrainSlot>();
  private shuttingDown = false;
  private lastCtrlC = 0;

  async start(): Promise<void> {
    this.logger.info("scheduler", 0, "启动中...");

    try {
      this.fsWatcher = new FSWatcher(ROOT);
    } catch {
      this.logger.warn("scheduler", 0, "FSWatcher creation failed — hot-reload disabled");
    }

    const globalConfig = await this.loadGlobalConfig();
    const brainIds = await this.discoverBrains();

    if (brainIds.length === 0) {
      this.logger.warn("scheduler", 0, "brains/ 下没有发现任何脑区");
      return;
    }

    for (const brainId of brainIds) {
      await this.initBrain(brainId, globalConfig);
    }

    for (const [id, slot] of this.slots) {
      slot.brain.run(slot.abortController.signal)
        .catch(err => this.logger.error("scheduler", 0, `brain '${id}' loop crashed`, err));
    }

    this.setupSignalHandlers();

    this.logger.info("scheduler", 0, "就绪，所有 brain loop 已启动");
  }

  private async discoverBrains(): Promise<string[]> {
    const brainsDir = join(ROOT, "brains");
    try {
      const entries = await readdir(brainsDir);
      const ids: string[] = [];
      for (const entry of entries) {
        const s = await stat(join(brainsDir, entry));
        if (s.isDirectory()) ids.push(entry);
      }
      return ids;
    } catch {
      return [];
    }
  }

  private isScriptBrain(brainId: string): boolean {
    return existsSync(join(ROOT, "brains", brainId, "src", "index.ts"));
  }

  private async initBrain(brainId: string, globalConfig: MineclawConfig): Promise<void> {
    const brainConfig = await this.loadBrainConfig(brainId);
    const queue = new EventQueue();
    const abortController = new AbortController();
    const brainDir = this.pathManager.brainDir(brainId);

    this.eventBus.register(brainId, queue);

    const emitFn = (event: Event): void => {
      const to = (event.payload as any)?.to as string | undefined;
      if (to && to !== brainId) {
        this.eventBus.emit(event, brainId);
      } else {
        queue.push(event);
      }
    };

    const subLoader = new SubscriptionLoader();
    subLoader.setEmitter(emitFn);
    subLoader.setBrainBoard(this.brainBoard);

    const selectorSub = brainConfig.subscriptions ?? { global: "all" as const };
    const sources = await subLoader.load({
      brainId,
      brainDir,
      globalDir: ROOT,
      selector: selectorSub,
    });

    if (this.isScriptBrain(brainId)) {
      const brain = new ScriptBrain({
        id: brainId,
        eventQueue: queue,
        coalesceMs: brainConfig.coalesceMs ?? 300,
        emit: emitFn,
        brainBoard: this.brainBoard,
        brainDir,
      });

      this.slots.set(brainId, { brain, queue, abortController, sources });
      this.brainBoard.set("__scheduler", `brain:${brainId}`, { status: "ready", type: "script" });
      this.logger.info("scheduler", 0, `ScriptBrain '${brainId}' 就绪`);
      return;
    }

    const modelRaw = brainConfig.model ?? globalConfig.defaults?.model;
    if (!modelRaw) {
      this.logger.warn("scheduler", 0, `脑区 '${brainId}' 无 model，跳过`);
      return;
    }

    const selectorTools = brainConfig.tools ?? { global: "all" as const };
    const toolLoader = new ToolLoader();
    const tools = await toolLoader.load({
      brainId,
      brainDir,
      globalDir: ROOT,
      selector: selectorTools,
    });

    const slotRegistry = new SlotRegistry();
    const contextEngine = new ContextEngine(slotRegistry);

    const selectorSlots = brainConfig.slots ?? { global: "all" as const };
    const slotLoader = new SlotLoader();
    slotLoader.setSlotContext({
      brainId,
      brainDir,
      brainBoard: this.brainBoard,
    });
    slotLoader.setCallbacks(
      (slots) => { for (const s of slots) slotRegistry.registerSlot(s); },
      (names) => { for (const n of names) slotRegistry.removeSlot(n); },
    );
    if (this.fsWatcher) slotLoader.registerWatchPatterns(this.fsWatcher);
    await slotLoader.load({
      brainId,
      brainDir,
      globalDir: ROOT,
      selector: selectorSlots,
    });

    let provider;
    let modelName: string;
    if (Array.isArray(modelRaw)) {
      provider = createFallbackProvider(modelRaw, brainConfig, (from, to, err) => {
        this.logger.warn(brainId, 0, `Fallback ${from} → ${to}: ${err.message}`);
      });
      modelName = modelRaw[0];
    } else {
      provider = createProvider(modelRaw, brainConfig);
      modelName = modelRaw;
    }

    const sessionManager = new SessionManager(brainId, this.pathManager);
    const existingSid = await sessionManager.currentSessionId();
    if (!existingSid) {
      await sessionManager.createSession();
    }

    const modelSpec = getModelSpec(modelName);

    // Inject __allTools for spawn_thought access
    for (const t of tools) {
      if (t.name === "spawn_thought") {
        const origExecute = t.execute;
        const allToolsRef = tools;
        t.execute = (args, toolCtx) => {
          (toolCtx as any).__allTools = allToolsRef;
          return origExecute(args, toolCtx);
        };
      }
    }

    const brain = new ConsciousBrain({
      id: brainId,
      model: modelName,
      provider,
      tools,
      brainConfig,
      eventQueue: queue,
      coalesceMs: brainConfig.coalesceMs ?? 300,
      emit: emitFn,
      brainBoard: this.brainBoard,
      slotRegistry,
      contextEngine,
      pathManager: this.pathManager,
      terminalManager: this.terminalManager,
      logger: this.logger,
      sessionManager,
      modelSpec,
      eventBus: this.eventBus,
      sources,
      workspace: ROOT,
    });

    this.brainBoard.set(brainId, "model", modelName);
    this.slots.set(brainId, { brain, queue, abortController, sources });
    this.brainBoard.set("__scheduler", `brain:${brainId}`, { status: "ready", type: "conscious" });

    this.logger.info(
      "scheduler", 0,
      `脑区 '${brainId}' 就绪 (model: ${modelName}, tools: [${tools.map(t => t.name).join(",")}])`,
    );
  }

  private setupSignalHandlers(): void {
    const handleSignal = async (sig: string) => {
      if (this.shuttingDown) return;

      const now = Date.now();
      if (sig === "SIGINT" && now - this.lastCtrlC < 3000) {
        this.logger.info("scheduler", 0, "二次 Ctrl+C — 全局关闭");
        await this.shutdownAll();
        process.exit(0);
      }

      if (sig === "SIGINT") {
        this.lastCtrlC = now;
        this.logger.info("scheduler", 0, "Ctrl+C — 停止当前活跃 brain (3秒内再按一次 = 全局关闭)");
        for (const [, slot] of this.slots) {
          if ((slot.brain as any).stop) {
            (slot.brain as any).stop();
          }
        }
        return;
      }

      // SIGTERM → graceful full shutdown
      this.logger.info("scheduler", 0, `收到 ${sig}，正在关闭...`);
      await this.shutdownAll();
      process.exit(0);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
  }

  async shutdownAll(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.logger.info("scheduler", 0, "并行关闭所有 brains (10s 超时)...");

    const shutdownPromises = [...this.slots.entries()].map(async ([id, slot]) => {
      try {
        if ((slot.brain as any).shutdown) {
          await (slot.brain as any).shutdown();
        } else {
          slot.abortController.abort();
          for (const source of slot.sources) {
            try { source.stop(); } catch { /* already stopped */ }
          }
        }
      } catch (err: any) {
        this.logger.error("scheduler", 0, `shutdown brain '${id}' failed`, err);
      }
    });

    const timeout = new Promise<void>(resolve => setTimeout(resolve, 10_000));
    await Promise.race([Promise.all(shutdownPromises), timeout]);

    for (const [, slot] of this.slots) {
      slot.abortController.abort();
    }

    this.fsWatcher?.close();
    this.terminalManager.cleanup(0);
    await this.logger.close();
  }

  async stop(): Promise<void> {
    await this.shutdownAll();
  }

  private async loadGlobalConfig(): Promise<MineclawConfig> {
    try {
      const raw = await readFile(join(ROOT, "mineclaw.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async loadBrainConfig(brainId: string): Promise<BrainJson> {
    try {
      const raw = await readFile(
        join(ROOT, "brains", brainId, "brain.json"),
        "utf-8",
      );
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}
