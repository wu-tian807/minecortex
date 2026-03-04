/** @desc Scheduler — singleton managers, brain discovery, ScriptBrain support, shutdown handling */

import { readFile, readdir, stat, mkdir, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type {
  BrainInterface,
  BrainJson,
  MineclawConfig,
  ModelsConfig,
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
import { createFSWatcher, getFSWatcher, type FSWatcher } from "../fs/watcher.js";
import { TerminalManager } from "../terminal/manager.js";
import { SessionManager } from "../session/session-manager.js";
import { Logger } from "./logger.js";
import { createProvider, createFallbackProvider, getModelSpec } from "../llm/provider.js";
import { BrainHooks } from "../hooks/brain-hooks.js";

const ROOT = process.cwd();

let _instance: Scheduler | null = null;

/** Get the global Scheduler singleton (null if not yet created). */
export function getScheduler(): Scheduler | null {
  return _instance;
}

/**
 * 解析模型配置
 * 优先级：brain.models > global.models
 */
function resolveModelsConfig(
  brainConfig: BrainJson,
  globalConfig: MineclawConfig,
): ModelsConfig {
  const globalModels = globalConfig.models ?? {};
  const brainModels = brainConfig.models ?? {};

  return {
    model: brainModels.model ?? globalModels.model,
    temperature: brainModels.temperature ?? globalModels.temperature,
    maxTokens: brainModels.maxTokens ?? globalModels.maxTokens,
    reasoningEffort: brainModels.reasoningEffort ?? globalModels.reasoningEffort,
    showThinking: brainModels.showThinking ?? globalModels.showThinking,
    maxRetries: brainModels.maxRetries ?? globalModels.maxRetries,
    baseDelayMs: brainModels.baseDelayMs ?? globalModels.baseDelayMs,
    maxDelayMs: brainModels.maxDelayMs ?? globalModels.maxDelayMs,
    timeout: brainModels.timeout ?? globalModels.timeout,
  };
}

interface ManagedBrain {
  brain: BrainInterface & { stop?(): void; shutdown?(): Promise<void>; free?(): Promise<void> };
  queue: EventQueue;
  abortController: AbortController;
  sources: EventSource[];
  hooks: BrainHooks;
}

export class Scheduler {
  private eventBus = new EventBus();
  private brainBoard = new BrainBoard(join(ROOT, "brains"));
  private pathManager = new PathManager(ROOT);
  private terminalManager = new TerminalManager(this.pathManager);
  private logger = new Logger(ROOT, this.pathManager);
  private get fsWatcher(): FSWatcher | null { return getFSWatcher(); }
  private brains = new Map<string, ManagedBrain>();
  private shuttingDown = false;
  private lastCtrlC = 0;

  constructor() {
    _instance = this;
  }

  /** Lightweight bootstrap — load brainBoard + FSWatcher, no brain discovery/start. */
  async init(): Promise<void> {
    this.brainBoard.loadFromDisk();
    try {
      createFSWatcher(ROOT);
      this.brainBoard.registerFSWatcher(this.fsWatcher!);
    } catch {
      this.logger.warn("scheduler", 0, "FSWatcher creation failed — hot-reload disabled");
    }
  }

  /** Access the shared BrainBoard instance. */
  getBrainBoard(): BrainBoard {
    return this.brainBoard;
  }

  /** Access a managed brain's queue and hooks by id. */
  getManagedBrain(id: string): { queue: EventQueue; hooks: BrainHooks } | null {
    const entry = this.brains.get(id);
    if (!entry) return null;
    return { queue: entry.queue, hooks: entry.hooks };
  }

  async start(): Promise<void> {
    this.logger.info("scheduler", 0, "启动中...");

    this.brainBoard.loadFromDisk();

    try {
      createFSWatcher(ROOT);
      this.brainBoard.registerFSWatcher(this.fsWatcher!);
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

    if (this.fsWatcher) {
      this.fsWatcher.register(/brains\/([^/]+)\/brain\.json$/, async (evt) => {
        const match = evt.path.match(/brains\/([^/]+)\/brain\.json$/);
        if (!match) return;
        const brainId = match[1];
        this.logger.info("scheduler", 0, `brain.json changed for '${brainId}', reloading config...`);
        const slot = this.brains.get(brainId);
        if (!slot) return;

        await this.terminalManager.loadBrainEnv(brainId);

        if (slot.brain instanceof ConsciousBrain) {
          const brainConfig = await this.loadBrainConfig(brainId);
          const globalCfg = await this.loadGlobalConfig();
          const modelsConfig = resolveModelsConfig(brainConfig, globalCfg);
          const modelRaw = modelsConfig.model;
          if (modelRaw) {
            const modelName = Array.isArray(modelRaw) ? modelRaw[0] : modelRaw;
            const models = Array.isArray(modelRaw) ? modelRaw : [modelRaw];
            const provider = createFallbackProvider(models, modelsConfig, {
              onRetry: (model, info) => {
                this.logger.warn(brainId, 0, `[${model}] 重试 ${info.attempt}/${info.maxRetries}: ${info.error.message}`);
              },
              onFallback: (from, to, err) => {
                this.logger.warn(brainId, 0, `Fallback ${from} → ${to}: ${err.message}`);
              },
            });
            const modelSpec = getModelSpec(modelName);
            slot.brain.updateConfig({ provider, modelSpec, brainConfig });
            this.logger.info("scheduler", 0, `脑区 '${brainId}' 热重载完成 (model: ${modelName})`);
          }
        }
      });

      this.fsWatcher.register(/directives\/[^/]+\.md$/, () => {
        this.logger.info("scheduler", 0, "Directive file changed (hot-reload via slot re-read on next prompt)");
      });

      this.fsWatcher.register(/^brains\/([^/]+)\/?$/, async (evt) => {
        const match = evt.path.match(/^brains\/([^/]+)\/?$/);
        if (!match) return;
        const brainId = match[1];
        if (!this.brains.has(brainId)) return;
        const brainDir = join(ROOT, "brains", brainId);
        if (!existsSync(brainDir)) {
          this.logger.info("scheduler", 0, `brain dir deleted, auto-freeing '${brainId}'`);
          await this.controlBrain("free", brainId);
        }
      });
    }

    for (const [id, slot] of this.brains) {
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

    await this.terminalManager.loadBrainEnv(brainId);

    this.eventBus.register(brainId, queue);

    const emitFn = (event: Event): void => {
      const to = (event.payload as any)?.to as string | undefined;
      if (to && to !== brainId) {
        this.eventBus.emit(event, brainId);
      } else {
        queue.push(event);
      }
    };

    const hooks = new BrainHooks();

    let brainRef: ConsciousBrain | null = null;

    const subLoader = new SubscriptionLoader();
    subLoader.setEmitter(emitFn);
    subLoader.setBrainBoard(this.brainBoard);
    subLoader.setHooks(hooks);
    subLoader.setCommandHandler((toolName, args, target, reason) => {
      const effectiveTarget = (!target || target === "/") ? brainId : target;
      const slot = this.brains.get(effectiveTarget);
      if (slot && "queueCommand" in slot.brain) {
        (slot.brain as ConsciousBrain).queueCommand(toolName, args, reason);
      } else if (effectiveTarget === brainId) {
        brainRef?.queueCommand(toolName, args, reason);
      } else {
        this.logger.warn("scheduler", 0, `command target '${effectiveTarget}' not found or not a ConsciousBrain`);
      }
    });

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

      this.brains.set(brainId, { brain, queue, abortController, sources, hooks });
      this.logger.info("scheduler", 0, `ScriptBrain '${brainId}' 就绪`);
      return;
    }

    const modelsConfig = resolveModelsConfig(brainConfig, globalConfig);
    if (!modelsConfig.model) {
      this.logger.warn("scheduler", 0, `脑区 '${brainId}' 无 model，跳过`);
      return;
    }

    const selectorTools = brainConfig.tools ?? { global: "all" as const };
    const toolLoader = new ToolLoader();
    if (this.fsWatcher) toolLoader.registerWatchPatterns(this.fsWatcher);
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

    const modelRaw = modelsConfig.model!;
    const models = Array.isArray(modelRaw) ? modelRaw : [modelRaw];
    const modelName = models[0];
    const provider = createFallbackProvider(models, modelsConfig, {
      onRetry: (model, info) => {
        this.logger.warn(brainId, 0, `[${model}] 重试 ${info.attempt}/${info.maxRetries}: ${info.error.message}`);
      },
      onFallback: (from, to, err) => {
        this.logger.warn(brainId, 0, `Fallback ${from} → ${to}: ${err.message}`);
      },
    });

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
      hooks,
    });

    brainRef = brain;
    this.brains.set(brainId, { brain, queue, abortController, sources, hooks });

    toolLoader.setCallback((tools) => brain.updateTools(tools));

    this.logger.info(
      "scheduler", 0,
      `脑区 '${brainId}' 就绪 (model: ${modelName}, tools: [${tools.map(t => t.name).join(",")}])`,
    );
  }

  // ─── Public API ───

  private static readonly DEFAULT_BRAIN_JSON = {
    model: null,
    subscriptions: { global: "none", enable: ["stdin"] },
    tools: { global: "all", disable: ["manage_brain"] },
    slots: { global: "all" },
  };

  private static defaultSoul(id: string): string {
    return `# ${id}\n\n你是 MineClaw 多脑系统中的 ${id} 脑区。\n\n## 职责\n- (请编辑此处)\n\n## 约束\n- 默认中文回复，代码注释用英文\n- 每步完成后简短汇报\n\n## 关系\n- 通过 send_message 与其他脑区协作\n- 用 manage_brain list 查看系统中所有活跃脑区\n\n## 工作方式\n1. 理解任务 → 拆解步骤\n2. 用工具直接执行\n3. 遇到问题先自己排查\n`;
  }

  async controlBrain(action: string, target?: string, opts?: {
    model?: string;
    soul?: string;
    subscriptions?: Record<string, unknown>;
    autoStart?: boolean;
  }): Promise<string> {
    this.logger.info("scheduler", 0, `brain_control: ${action}${target ? ` → '${target}'` : ""}`);

    switch (action) {
      case "list":      return this.doList();
      case "create":    return this.doCreate(target!, opts);
      case "start":     return this.doStart(target!);
      case "stop":      return this.doStop(target!);
      case "shutdown":  return this.doShutdown(target!);
      case "restart":   return this.doRestart(target!);
      case "free":      return this.doFree(target!);
      case "resume":    return this.doResume(target!);
      default:          return `Unknown action: '${action}'`;
    }
  }

  // ─── Private lifecycle methods ───

  private doList(): string {
    const ids = [...this.brains.keys()];
    if (ids.length === 0) return "No active brains.";
    return "Active brains:\n" + ids.map(id => `  - ${id}`).join("\n");
  }

  private async doCreate(id: string, opts?: {
    model?: string;
    soul?: string;
    subscriptions?: Record<string, unknown>;
    autoStart?: boolean;
  }): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return `Invalid brain id '${id}'. Use only alphanumeric, dash, underscore.`;
    }
    const brainDir = join(ROOT, "brains", id);
    try {
      await access(brainDir);
      return `Brain directory already exists: brains/${id}/`;
    } catch { /* doesn't exist — proceed */ }

    await mkdir(brainDir, { recursive: true });
    const brainJson = { ...Scheduler.DEFAULT_BRAIN_JSON } as Record<string, unknown>;
    if (opts?.model) brainJson.model = opts.model;
    if (opts?.subscriptions) brainJson.subscriptions = opts.subscriptions;
    await writeFile(join(brainDir, "brain.json"), JSON.stringify(brainJson, null, 2) + "\n", "utf-8");
    await writeFile(join(brainDir, "soul.md"), opts?.soul ?? Scheduler.defaultSoul(id), "utf-8");

    if (opts?.autoStart) return this.doStart(id);
    return `Brain '${id}' created`;
  }

  private async doStart(id: string): Promise<string> {
    if (this.brains.has(id)) return `Brain '${id}' is already running`;
    const brainDir = join(ROOT, "brains", id);
    if (!existsSync(brainDir)) return `Brain directory not found: brains/${id}/`;

    const globalConfig = await this.loadGlobalConfig();
    await this.initBrain(id, globalConfig);
    const slot = this.brains.get(id);
    if (slot) {
      slot.brain.run(slot.abortController.signal)
        .catch(err => this.logger.error("scheduler", 0, `brain '${id}' loop crashed`, err));
    }
    return `Brain '${id}' started`;
  }

  private doStop(id: string): string {
    const slot = this.brains.get(id);
    if (!slot) return `Unknown brain: '${id}'`;
    slot.brain.stop?.();
    return `Brain '${id}' stopped`;
  }

  private async doShutdown(id: string): Promise<string> {
    const slot = this.brains.get(id);
    if (!slot) return `Unknown brain: '${id}'`;
    await slot.brain.shutdown?.();
    slot.abortController.abort();
    return `Brain '${id}' shut down`;
  }

  private async doRestart(id: string): Promise<string> {
    const slot = this.brains.get(id);
    if (!slot) return `Unknown brain: '${id}'`;
    await slot.brain.shutdown?.();
    slot.abortController.abort();
    this.brains.delete(id);
    const globalConfig = await this.loadGlobalConfig();
    await this.initBrain(id, globalConfig);
    const newSlot = this.brains.get(id);
    if (newSlot) {
      newSlot.brain.run(newSlot.abortController.signal)
        .catch(err => this.logger.error("scheduler", 0, `brain '${id}' loop crashed after restart`, err));
    }
    return `Brain '${id}' restarted`;
  }

  private doResume(id: string): string {
    const slot = this.brains.get(id);
    if (!slot) return `Unknown brain: '${id}'`;
    slot.queue.push({
      source: "scheduler",
      type: "resume",
      payload: { prompt: "<CONTINUE>" },
      ts: Date.now(),
      priority: 0,
    });
    return `Brain '${id}' resumed`;
  }

  private async doFree(id: string): Promise<string> {
    const slot = this.brains.get(id);
    if (slot) {
      await slot.brain.free?.();
      slot.abortController.abort();
      this.brains.delete(id);
    }
    const brainDir = join(ROOT, "brains", id);
    if (existsSync(brainDir)) {
      await rm(brainDir, { recursive: true, force: true });
      this.logger.info("scheduler", 0, `brain dir deleted: brains/${id}/`);
    }
    return `Brain '${id}' freed`;
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
        for (const [, slot] of this.brains) {
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

    const shutdownPromises = [...this.brains.entries()].map(async ([id, slot]) => {
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

    for (const [, slot] of this.brains) {
      slot.abortController.abort();
    }

    getFSWatcher()?.close();
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
