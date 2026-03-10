/** @desc Scheduler — singleton managers, brain discovery, ScriptBrain support, shutdown handling */

import { readFile, readdir, stat, mkdir, writeFile, access, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import type {
  BrainJson,
  MinecortexConfig,
  ModelsConfig,
  BrainInitConfig,
  CapabilitySelector,
  CapabilityPathRedirects,
} from "./types.js";
import { EventBus } from "./event-bus.js";
import { BrainBoard } from "./brain-board.js";
import { ConsciousBrain, type ConsciousBrainInitConfig } from "./brain.js";
import { ScriptBrain } from "./script-brain.js";
import { BaseBrain } from "./base-brain.js";
import { BaseLoader } from "../loaders/base-loader.js";
import { ToolLoader } from "../loaders/tool-loader.js";
import { SubscriptionLoader } from "../loaders/subscription-loader.js";
import { SlotLoader } from "../loaders/slot-loader.js";
import { ContextEngine } from "../context/context-engine.js";
import { SlotRegistry } from "../context/slot-registry.js";
import { initPathManager, type PathManager } from "../fs/path-manager.js";
import { createFSWatcher, getFSWatcher, type FSWatcher } from "../fs/watcher.js";
import { getTerminalManager, initTerminalManager } from "../terminal/manager.js";
import { SessionManager } from "../session/session-manager.js";
import { Logger } from "./logger.js";
import { DEFAULT_BRAIN_JSON } from "../defaults/templates.js";
import { BRAIN_DEFAULTS } from "../defaults/brain-defaults.js";

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
  globalConfig: MinecortexConfig,
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

export class Scheduler {
  private readonly pathManager: PathManager;
  private readonly brainBoard: BrainBoard;
  private readonly terminalManager: ReturnType<typeof initTerminalManager>;
  private readonly logger: Logger;
  private readonly eventBus = new EventBus();
  private get fsWatcher(): FSWatcher | null { return getFSWatcher(); }
  private brains = new Map<string, BaseBrain>();
  private shuttingDown = false;
  private lastCtrlC = 0;

  constructor() {
    _instance = this;
    this.pathManager = initPathManager(ROOT);
    this.brainBoard = new BrainBoard(this.pathManager.bundle().brainsDir());
    this.terminalManager = initTerminalManager(this.pathManager);
    this.logger = new Logger(this.pathManager);
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

  /** Subscribe to all EventBus events — for external observers like the CLI renderer.
   *  Returns an unsubscribe function. */
  observeEvents(handler: (e: import("./types.js").Event) => void): () => void {
    return this.eventBus.observe(handler);
  }

  /** Access a brain by id. */
  getBrain(id: string): BaseBrain | null {
    return this.brains.get(id) ?? null;
  }

  /** Route an event through the shared EventBus (e.g. renderer → agent via event.to). */
  emit(event: import("./types.js").Event): void {
    this.eventBus.emit(event);
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
      this.logger.warn("scheduler", 0, "bundle/brains/ 下没有发现任何脑区");
      return;
    }

    for (const brainId of brainIds) {
      await this.initBrain(brainId, globalConfig);
    }

    this.registerHotReloadHandlers();

    for (const id of this.brains.keys()) {
      this.runBrain(id);
    }

    this.setupSignalHandlers();

    this.logger.info("scheduler", 0, "就绪，所有 brain loop 已启动");
  }

  private registerHotReloadHandlers(): void {
    if (!this.fsWatcher) return;

    // Brain directory deletion — pattern now under bundle/brains/
    this.fsWatcher.register(/^bundle\/brains\/([^/]+)\/?$/, async (evt) => {
      const match = evt.path.match(/^bundle\/brains\/([^/]+)\/?$/);
      if (!match) return;
      const brainId = match[1];
      if (!this.brains.has(brainId)) return;
      if (!existsSync(this.pathManager.local(brainId).root())) {
        this.logger.info("scheduler", 0, `brain dir deleted, auto-removing '${brainId}'`);
        await this.removeBrain(brainId);
      }
    });
  }

  private async discoverBrains(): Promise<string[]> {
    const brainsDir = this.pathManager.bundle().brainsDir();
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
    return existsSync(join(this.pathManager.local(brainId).root(), "src", "index.ts"));
  }

  private createBrainInitConfig(brainId: string, brainConfig: BrainJson): BrainInitConfig {
    return {
      id: brainId,
      brainDir: this.pathManager.local(brainId).root(),
      brainJson: brainConfig,
      brainBoard: this.brainBoard,
      pathManager: this.pathManager,
      logger: this.logger,
      eventBus: this.eventBus,
    };
  }

  private async initBrain(brainId: string, globalConfig: MinecortexConfig): Promise<void> {
    const brainConfig = await this.loadBrainConfig(brainId);
    const brainDir = this.pathManager.local(brainId).root();
    const baseConfig = this.createBrainInitConfig(brainId, brainConfig);
    const toolSources = BaseLoader.buildSources(this.pathManager, brainId, "tools", brainConfig.paths?.tools ? (isAbsolute(brainConfig.paths.tools) ? brainConfig.paths.tools : join(ROOT, brainConfig.paths.tools)) : undefined);
    const slotSources = BaseLoader.buildSources(this.pathManager, brainId, "slots", brainConfig.paths?.slots ? (isAbsolute(brainConfig.paths.slots) ? brainConfig.paths.slots : join(ROOT, brainConfig.paths.slots)) : undefined);

    await this.terminalManager.loadBrainEnv(brainId);

    // ScriptBrain path
    if (this.isScriptBrain(brainId)) {
      const brain = new ScriptBrain(baseConfig);
      const { sources } = await this.loadSubscriptions(brainId, brainDir, brainConfig, brain);
      brain.setSources(sources);
      this.brains.set(brainId, brain);
      this.logger.info("scheduler", 0, `ScriptBrain '${brainId}' 就绪`);
      return;
    }

    // ConsciousBrain path
    const modelsConfig = resolveModelsConfig(brainConfig, globalConfig);
    if (!modelsConfig.model) {
      this.logger.warn("scheduler", 0, `脑区 '${brainId}' 无 model，跳过`);
      return;
    }

    // Load tools
    const selectorTools = brainConfig.tools ?? BRAIN_DEFAULTS.tools;
    const toolLoader = new ToolLoader();
    toolLoader.setLogContext(brainId);
    if (this.fsWatcher) toolLoader.registerWatchPatterns(this.fsWatcher);
    const tools = await toolLoader.load({
      brainId,
      brainDir,
      pathManager: this.pathManager,
      selector: selectorTools,
      capabilitySources: toolSources,
    });

    // Setup slot registry and context engine
    const slotRegistry = new SlotRegistry();
    const contextEngine = new ContextEngine(slotRegistry);

    const selectorSlots = brainConfig.slots ?? BRAIN_DEFAULTS.slots;
    const slotLoader = new SlotLoader();
    slotLoader.setLogContext(brainId);
    slotLoader.setSlotContext({
      brainId,
      brainDir,
      brainBoard: this.brainBoard,
      pathManager: this.pathManager,
    });
    slotLoader.setCallbacks(
      (slots) => { for (const s of slots) slotRegistry.registerSlot(s); },
      (names) => { for (const n of names) slotRegistry.removeSlot(n); },
    );
    if (this.fsWatcher) slotLoader.registerWatchPatterns(this.fsWatcher);
    await slotLoader.load({
      brainId,
      brainDir,
      pathManager: this.pathManager,
      selector: selectorSlots,
      capabilitySources: slotSources,
    });

    // Session manager
    const sessionManager = new SessionManager(brainId, this.pathManager);
    const existingSid = await sessionManager.currentSessionId();
    if (!existingSid) {
      await sessionManager.createSession();
    }

    // ConsciousBrain — workspace 指向 bundle/shared/workspace 供 AI 作为共享操作空间
    const consciousConfig: ConsciousBrainInitConfig = {
      ...baseConfig,
      tools,
      dynamicTools: toolLoader.dynamic,
      dynamicSubscriptions: { register: () => {}, release: () => {}, get: () => undefined, list: () => [] },
      slotRegistry,
      contextEngine,
      sessionManager,
      workspace: this.pathManager.bundle().sharedDir("workspace"),
      globalModels: globalConfig.models ?? {},
    };

    const brain = new ConsciousBrain(consciousConfig);

    // Load subscriptions AFTER brain creation (so hooks is available)
    const { sources, loader: subLoader } = await this.loadSubscriptions(brainId, brainDir, brainConfig, brain);
    brain.setSources(sources);
    brain.setDynamicSubscriptions(subLoader.dynamic);

    this.brains.set(brainId, brain);

    // Tool hot-reload callback
    toolLoader.setCallback((updatedTools) => brain.updateTools(updatedTools));

    this.logger.info(
      "scheduler", 0,
      `脑区 '${brainId}' 就绪 (model: ${modelsConfig.model}, tools: [${tools.map(t => t.name).join(",")}])`,
    );
  }

  // ─── Private helper: load subscriptions with brain's hooks ───

  private async loadSubscriptions(
    brainId: string,
    brainDir: string,
    brainConfig: BrainJson,
    brain: BaseBrain,
  ): Promise<{ sources: import("./types.js").EventSource[]; loader: SubscriptionLoader }> {
    const subLoader = new SubscriptionLoader();
    subLoader.setLogContext(brainId);
    subLoader.setEmitter((event) => brain.pushEvent(event));

    const brainContext: import("./types.js").BrainContextAPI = {
      id: brainId,
      brainDir,
      hooks: brain.hooks,
      brainBoard: this.brainBoard,
      pathManager: this.pathManager,
      eventBus: brain.boundEventBus,
      queueCommand: (toolName, args, reason) => {
        if (brain instanceof ConsciousBrain) {
          brain.queueCommand(toolName, args, reason);
        } else {
          this.logger.warn("scheduler", 0, `queueCommand on non-ConsciousBrain: ${brainId}`);
        }
      },
    };
    subLoader.setBrainContext(brainContext);

    if (this.fsWatcher) subLoader.registerWatchPatterns(this.fsWatcher);

    const selectorSub = brainConfig.subscriptions ?? BRAIN_DEFAULTS.subscriptions;
    const subSources = BaseLoader.buildSources(
      this.pathManager, brainId, "subscriptions",
      brainConfig.paths?.subscriptions
        ? (isAbsolute(brainConfig.paths.subscriptions) ? brainConfig.paths.subscriptions : join(ROOT, brainConfig.paths.subscriptions))
        : undefined,
    );
    const sources = await subLoader.load({
      brainId,
      brainDir,
      pathManager: this.pathManager,
      selector: selectorSub,
      capabilitySources: subSources,
    });
    return { sources, loader: subLoader };
  }

  // ─── Private helper: remove brain from memory ───

  private async removeBrain(id: string): Promise<void> {
    const brain = this.brains.get(id);
    if (!brain) return;
    await brain.shutdown();
    this.brains.delete(id);
    this.logger.info("scheduler", 0, `brain '${id}' removed from memory`);
  }

  // ─── Public API ───

  private static defaultSoul(id: string): string {
    return `# ${id}\n\n你是 MineCortex 多脑系统中的 ${id} 脑区。\n\n## 职责\n- (请编辑此处)\n\n## 约束\n- 默认中文回复，代码注释用英文\n- 每步完成后简短汇报\n\n## 关系\n- 通过 send_message 与其他脑区协作\n- 用 manage_brain list 查看系统中所有活跃脑区\n\n## 工作方式\n1. 理解任务 → 拆解步骤\n2. 用工具直接执行\n3. 遇到问题先自己排查\n`;
  }

  async controlBrain(action: string, target?: string, opts?: {
    model?: string;
    soul?: string;
    subscriptions?: Record<string, unknown>;
    tools?: CapabilitySelector;
    slots?: CapabilitySelector;
    paths?: CapabilityPathRedirects;
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
    tools?: CapabilitySelector;
    slots?: CapabilitySelector;
    paths?: CapabilityPathRedirects;
    autoStart?: boolean;
  }): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return `Invalid brain id '${id}'. Use only alphanumeric, dash, underscore.`;
    }
    const brainDir = this.pathManager.local(id).root();
    try {
      await access(brainDir);
      return `Brain directory already exists: bundle/brains/${id}/`;
    } catch { /* doesn't exist — proceed */ }

    await mkdir(brainDir, { recursive: true });
    const brainJson = { ...DEFAULT_BRAIN_JSON } as Record<string, unknown>;
    if (opts?.model) {
      brainJson.models = { ...(brainJson.models as object ?? {}), model: opts.model };
    }
    if (opts?.subscriptions) brainJson.subscriptions = opts.subscriptions;
    if (opts?.tools) brainJson.tools = opts.tools;
    if (opts?.slots) brainJson.slots = opts.slots;
    if (opts?.paths) brainJson.paths = opts.paths;
    await writeFile(join(brainDir, "brain.json"), JSON.stringify(brainJson, null, 2) + "\n", "utf-8");
    await writeFile(join(brainDir, "soul.md"), opts?.soul ?? Scheduler.defaultSoul(id), "utf-8");

    if (opts?.autoStart) return this.doStart(id);
    return `Brain '${id}' created`;
  }

  private async doStart(id: string): Promise<string> {
    if (this.brains.has(id)) return `Brain '${id}' is already running`;
    const brainDir = this.pathManager.local(id).root();
    if (!existsSync(brainDir)) return `Brain directory not found: bundle/brains/${id}/`;

    const globalConfig = await this.loadGlobalConfig();
    await this.initBrain(id, globalConfig);
    this.runBrain(id);
    return `Brain '${id}' started`;
  }

  private doStop(id: string): string {
    const brain = this.brains.get(id);
    if (!brain) return `Unknown brain: '${id}'`;
    brain.stop();
    return `Brain '${id}' stopped`;
  }

  private async doShutdown(id: string): Promise<string> {
    const brain = this.brains.get(id);
    if (!brain) return `Unknown brain: '${id}'`;
    await brain.shutdown();
    return `Brain '${id}' shut down`;
  }

  private async doRestart(id: string): Promise<string> {
    const brain = this.brains.get(id);
    if (!brain) return `Unknown brain: '${id}'`;
    await this.removeBrain(id);
    const globalConfig = await this.loadGlobalConfig();
    await this.initBrain(id, globalConfig);
    this.runBrain(id);
    return `Brain '${id}' restarted`;
  }

  private async doFree(id: string): Promise<string> {
    const brain = this.brains.get(id);
    if (brain) {
      await brain.free();
      this.brains.delete(id);
    }
    const brainDir = this.pathManager.local(id).root();
    if (existsSync(brainDir)) {
      await rm(brainDir, { recursive: true, force: true });
      this.logger.info("scheduler", 0, `brain dir deleted: bundle/brains/${id}/`);
    }
    return `Brain '${id}' freed`;
  }

  /** Start a brain's run loop (fire-and-forget with error logging) */
  private runBrain(id: string): void {
    const brain = this.brains.get(id);
    if (!brain) return;
    brain.run(brain.signal)
      .catch(err => this.logger.error("scheduler", 0, `brain '${id}' loop crashed`, err));
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
        for (const brain of this.brains.values()) {
          brain.stop();
        }
        return;
      }

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

    const shutdownPromises = [...this.brains.entries()].map(async ([id, brain]) => {
      try {
        await brain.shutdown();
      } catch (err: any) {
        this.logger.error("scheduler", 0, `shutdown brain '${id}' failed`, err);
      }
    });

    const timeout = new Promise<void>(resolve => setTimeout(resolve, 10_000));
    await Promise.race([Promise.all(shutdownPromises), timeout]);

    getFSWatcher()?.close();
    getTerminalManager().cleanup(0);
    await this.logger.close();
  }

  async stop(): Promise<void> {
    await this.shutdownAll();
  }

  private async loadGlobalConfig(): Promise<MinecortexConfig> {
    try {
      const raw = await readFile(join(ROOT, "minecortex.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async loadBrainConfig(brainId: string): Promise<BrainJson> {
    try {
      const raw = await readFile(join(this.pathManager.local(brainId).root(), "brain.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}
