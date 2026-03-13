/** Core public primitives — imported by tools/, subscriptions/, slots/ */

// ─── Event System ───

export type EventHandoff = "silent" | "turn" | "innerLoop" | "steer";

export interface Event {
  source: string;       // e.g. "cli", "heartbeat", "brain:advisor", "tool:subagent"
  type: string;         // e.g. "message", "tick", "block_break"
  payload: unknown;
  ts: number;
  to?: string;          // routing target: brainId, "*" for broadcast, or omitted for observers only
  priority?: number;    // 0=immediate, 1=normal(default), 2=low
  handoff?: EventHandoff; // default="turn": silent=queue only, turn=next turn, innerLoop=yield after current loop, steer=interrupt current turn
}

export interface EventQueueInterface {
  push(event: Event): void;
  drain(): Event[];
  pending(): number;
  hasHandoff(handoff: EventHandoff): boolean;
  onSteer(cb: () => void): { dispose(): void };
}

/** Brain-bound EventBus facade exposed to tools and subscriptions.
 *  emit()       — goes through globalHandlers + routing (renderer/recorder can observe via onAny).
 *  emitToSelf() — pushes directly to this brain's own queue; invisible to other brains and observers. */
export interface EventBusAPI {
  emit(event: Event): void;
  emitToSelf(event: Event): void;
  /** Register a global observer that sees every event passing through the bus. Returns unsubscribe fn. */
  observe(handler: (event: Event) => void): () => void;
}

// ─── Multimodal Content ───

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "video"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

export type SerializedPart =
  | ContentPart
  | { type: "image_ref"; path: string; mimeType: string }
  | { type: "video_ref"; path: string; mimeType: string }
  | { type: "audio_ref"; path: string; mimeType: string };

export type MediaContentPart = Exclude<ContentPart, { type: "text"; text: string }>;
export type MediaRefPart = Exclude<SerializedPart, ContentPart>;

export function isMediaContentPart(part: ContentPart): part is MediaContentPart {
  return part.type === "image" || part.type === "video" || part.type === "audio";
}

export function isMediaRefPart(part: SerializedPart): part is MediaRefPart {
  return part.type === "image_ref" || part.type === "video_ref" || part.type === "audio_ref";
}

// ─── Model Spec ───

export type InputModality = "text" | "image" | "video" | "audio";
export type ReasoningEffort = "low" | "medium" | "high";

export interface ModelSpec {
  input: InputModality[];
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
  defaultTemperature: number;
}

// ─── Brain Config ───

export interface CapabilitySelector {
  /**
   * Controls the global (framework) source layer (source.id === "global").
   *   "all"  → include all framework capabilities
   *   "none" → include none (default)
   */
  global: "all" | "none";
  /**
   * Controls the bundle-shared source layer (source.id === "bundle").
   * Shared across all brains in the bundle.
   *   "all"  → include all bundle-shared capabilities
   *   "none" → include none (default when absent)
   */
  bundle?: "all" | "none";
  enable?: string[];
  disable?: string[];
  config?: Record<string, Record<string, unknown>>;
}

export interface CapabilitySource {
  id: string;
  dir: string;
}

export interface CapabilityDescriptor {
  name: string;
  tag?: string;
  exposedName: string;
  path: string;
  /** Source layer id this descriptor was scanned from (e.g. "global" or brainId). */
  sourceId?: string;
}

export interface ModelsConfig {
  /** 模型名称，可以是单个或数组（fallback 链） */
  model?: string | string[];
  /** 温度 */
  temperature?: number;
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** 推理强度 */
  reasoningEffort?: ReasoningEffort;
  /** 是否显示思考过程 */
  showThinking?: boolean;
  /** 单个模型的最大重试次数，默认 3 */
  maxRetries?: number;
  /** 基础重试延迟（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 最大重试延迟（毫秒），默认 30000 */
  maxDelayMs?: number;
  /** LLM 调用超时（毫秒），-1 = 永不超时，默认 -1 */
  timeout?: number;
}

export interface BrainJson {
  /** LLM 模型配置 */
  models?: ModelsConfig;

  /** 事件合并窗口（毫秒），默认 300 */
  coalesceMs?: number;

  /** 单轮最大 LLM 调用次数，默认 200 */
  maxIterations?: number;

  /** 能力选择器 */
  subscriptions?: CapabilitySelector;
  tools?: CapabilitySelector;
  slots?: CapabilitySelector;

  /** Session 压缩配置 */
  session?: {
    /** 微压缩保留最近 N 个 tool_result，默认 8 */
    keepToolResults?: number;
    /** 微压缩保留最近 N 个多媒体消息，默认 2 */
    keepMedias?: number;
  };


  /** 时区，默认 Asia/Shanghai */
  timezone?: string;

  /**
   * 默认工作目录（相对路径以 .home 为基准，或绝对路径）。
   * 不设置时默认为 bundle/brains/{id}/.home/。
   * 设置后作为 currentDir 初始值，focus 工具无参调用时也重置到此路径。
   */
  defaultDir?: string;
}

export interface MinecortexConfig {
  /** 全局模型配置 */
  models?: ModelsConfig;
}

// ─── Tool System ───

export type ToolOutput = string | ContentPart[];

export interface ToolDefinition {
  name: string;
  description: string;
  /** Behavioral guidance injected into the system prompt via the tools slot. */
  guidance?: string;
  ccVersion?: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

// ─── DynamicRegistry — unified runtime register/release interface ───

/**
 * Generic interface for runtime (in-memory) registration of capabilities.
 * All three capability systems (slot / tool / subscription) implement this
 * with their respective instance type T so their dynamic APIs stay symmetric.
 */
export interface DynamicRegistry<T> {
  register(key: string, instance: T): void;
  release(key: string): void;
  get(key: string): T | undefined;
  list(): T[];
}

/** Slot-specific dynamic API: adds content-centric `update` helper. */
export interface DynamicSlotAPI extends DynamicRegistry<string> {
  update(id: string, content: string): void;
}

/** Runtime tool registration/release, exposed as ctx.tools in ToolContext. */
export type DynamicToolAPI = DynamicRegistry<ToolDefinition>;

/** Runtime subscription registration/release, exposed as ctx.subscriptions in ToolContext. */
export type DynamicSubscriptionAPI = DynamicRegistry<EventSource>;

/**
 * Minimal session-management surface exposed to tools.
 * Deliberately narrow — tools should not reach into full session internals.
 */
export interface SessionManagerAPI {
  /** Read normalized messages from a specific session (with media deserialization). */
  loadSnapshot(sid: string): Promise<{ messages: unknown[] } | null>;
  /** Create a new session, write initial messages, and switch the pointer. */
  newSession(initialMessages?: unknown[]): Promise<string>;
  /** Merge arbitrary key-value pairs into session.json without overwriting unrelated fields. */
  updateSessionMeta(updates: Record<string, unknown>): Promise<void>;
}

// ─── BrainBoard (reactive state registry) ───

export type WatchCallback = (value: unknown, prev: unknown) => void;

export interface BrainBoardSetOptions {
  persist?: boolean;
}

export interface BrainBoardAPI {
  set(brainId: string, key: string, value: unknown, options?: BrainBoardSetOptions): void;
  get(brainId: string, key: string): unknown;
  remove(brainId: string, key: string): void;
  removeAll(brainId: string): void;
  removeByPrefix(prefix: string): void;
  getAll(brainId: string): Record<string, unknown>;
  brainIds(): string[];
  watch(brainId: string, key: string, cb: WatchCallback): () => void;
  loadFromDisk(): void;
  registerFSWatcher(watcher: FSWatcherAPI): void;
}

// ─── Shared capability context ───

export interface BrainContext {
  brainId: string;
  brainDir: string;
  signal: AbortSignal;
  eventBus: EventBusAPI;
  brainBoard: BrainBoardAPI;
  pathManager: PathManagerAPI;
  /** Brain's environment variables (tool execution may populate this dynamically). */
  env: Record<string, string>;
  /** Returns the live in-memory brain.json reference for this brain. */
  getBrainJson: () => BrainJson;
  hooks?: import("../hooks/types.js").BrainHooksAPI;
  queueCommand?: (toolName: string, args: Record<string, string>, reason?: string) => void;
  /** Session management — use for creating/switching sessions inside tools. */
  sessionManager?: SessionManagerAPI;
  slot?: DynamicSlotAPI;
  tools?: DynamicToolAPI;
  subscriptions?: DynamicSubscriptionAPI;
}

export type ToolContext = BrainContext;

// ─── EventSource (pluggable subscription, factory pattern) ───

export type SubscriptionContext = BrainContext;

export type EventSourceFactory = (ctx: SubscriptionContext) => EventSource;

export interface EventSource {
  name: string;
  start(emit: (event: Event) => void): void;
  stop(): void;
}

// ─── PathManager 分层接口 ─────────────────────────────────────────────────────
//
// 三层模型（优先级：local > bundle > global）：
//   global()          — 根目录，系统公共能力，长期稳定，所有 bundle 可读
//   bundle()          — bundle/ 层，当前活跃 bundle 的共享运行时
//   local(brainId)    — bundle/brains/{id}/ 层，单个 brain 的私有空间
//
// 每层都有三种内置核心能力目录（tools/slots/subscriptions）。
// 用法示例：
//   pathManager.global().toolsDir()                    → tools/
//   pathManager.bundle().brainsDir()                   → bundle/brains/
//   pathManager.bundle().sharedDir("workspace")        → bundle/shared/workspace/
//   pathManager.local("coder").toolsDir()              → bundle/brains/coder/tools/
//   pathManager.local("coder").root()                  → bundle/brains/coder/

/** 三层共享的能力目录访问接口 */
export interface CapabilityLayerAPI {
  /** 内置能力：tools */
  toolsDir(): string;
  /** 内置能力：slots */
  slotsDir(): string;
  /** 内置能力：subscriptions */
  subscriptionsDir(): string;
}

/** Global 层：根目录级，长期稳定，AI 默认只读（evolve 模式除外） */
export interface GlobalLayerAPI extends CapabilityLayerAPI {
  root(): string;
  logsDir(brainId?: string): string;
  keyDir(): string;
  packsDir(): string;
  backupsDir(): string;
  minecortexConfig(): string;
}

/** Bundle 层：bundle/ 运行时，当前活跃 bundle 的可写共享空间 */
export interface BundleLayerAPI extends CapabilityLayerAPI {
  /** bundle/ */
  root(): string;
  /** bundle/brains/ */
  brainsDir(): string;
  /** bundle/manifest.json */
  manifest(): string;
  /** bundle/state/ */
  stateDir(): string;
  /** bundle/shared/ */
  sharedDir(): string;
  /** bundle/shared/workspace/ */
  sharedWorkspace(): string;
  /** bundle/shared/sandbox/ */
  sandboxDir(): string;
  /** bundle/shared/sandbox/mounts.json */
  sandboxMounts(): string;
  /** bundle/shared/sandbox/overlays/ */
  sandboxOverlays(): string;
}

/** Local 层：bundle/brains/{brainId}/，单个 brain 的私有可写空间 */
export interface LocalLayerAPI extends CapabilityLayerAPI {
  /** bundle/brains/{brainId}/ */
  root(): string;
  /** bundle/brains/{brainId}/sessions/ */
  sessionsDir(): string;
  /** bundle/brains/{brainId}/brain.json */
  config(): string;
  /** bundle/brains/{brainId}/soul.md */
  soul(): string;
  /** bundle/brains/{brainId}/.home/ - User Terminal $HOME */
  homeDir(): string;
  /** bundle/brains/{brainId}/.tmp/ - 沙盒私有垃圾堆 */
  tmpDir(): string;
}

export interface PathManagerAPI {
  /** 项目根目录 */
  root(): string;
  /** Global 层（tools/ slots/ subscriptions/ 等公共能力） */
  global(): GlobalLayerAPI;
  /** Bundle 层（bundle/brains/ bundle/shared/ 等运行时目录） */
  bundle(): BundleLayerAPI;
  /** Local 层（bundle/brains/{brainId}/ 单个 brain 私有目录） */
  local(brainId: string): LocalLayerAPI;
  /** packs/{packId}/ */
  packDir(packId: string): string;
  /** backups/{backupId}/ */
  backupDir(backupId: string): string;
  /**
   * 将相对路径解析为特定 brain 的 private .home 下的绝对路径。
   * 支持多平台路径解析，如果输入的是绝对路径，则返回该绝对路径本身。
   */
  resolve(input: { path: string; brain?: string }, callerBrainId: string): string;
  checkPermission(absPath: string, op: "read" | "write", callerBrainId: string, evolve: boolean): boolean;
}

// ─── Terminal Manager ───

export interface TerminalInstance {
  id: string;
  sessionId: string;
  pid: number;
  command: string;
  cwd: string;
  /** undefined means it is a system-level terminal */
  brainId?: string;
  startedAt: number;
  backgrounded?: boolean;
  exitCode?: number;
  elapsedMs?: number;
  logFile: string;
}

export interface ExecOpts {
  cwd?: string;
  /** Only applied when a brand-new bash session is created (e.g. after timeout/background).
   *  Has no effect if an existing session is reused — preserving the model's own cd state. */
  initialCwd?: string;
  env?: Record<string, string>;
  /** If empty or undefined, runs the command in a system-level terminal instead of a brain-level user terminal. */
  brainId?: string;
  /** Timeout in ms. If <= 0, the command will run indefinitely without backgrounding. Default: 30s. */
  timeoutMs?: number;
  /** Short description included in the log filename for easy identification. */
  description?: string;
}

export interface TerminalManagerAPI {
  /** 幂等初始化：下载独立 Python/Node、检测 unshare 可用性。多次调用复用同一 Promise。 */
  init(): Promise<void>;
  /** 同步查询初始化是否已完成。 */
  isReady(): boolean;
  /** 异步等待初始化完成；若尚未初始化则自动调用 init() 并等待完成。 */
  ensureReady(): Promise<void>;
  exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  get(id: string): TerminalInstance | undefined;
  list(filter?: { brainId?: string; status?: string }): TerminalInstance[];
  kill(id: string): boolean;
  cleanup(maxAge?: number): void;
  loadSystemEnv(): Promise<void>;
  loadBrainEnv(brainId: string): Promise<void>;
}

export interface ExecResult {
  terminalId: string;
  logFile: string;
  stdout: string;
  exitCode?: number;
  backgrounded: boolean;
  hint?: string;
}

// ─── Brain Interface ───

export interface BrainInterface {
  id: string;
  run(signal: AbortSignal): Promise<void>;
  stop?(): void;
  shutdown?(): Promise<void>;
  free?(): Promise<void>;
}

// ─── Brain Init Config (passed to BaseBrain constructor) ───

export interface BrainInitConfig {
  id: string;
  brainDir: string;
  brainJson: BrainJson;
  brainBoard: BrainBoardAPI;
  pathManager: PathManagerAPI;
  logger: import("./logger.js").Logger;
  eventBus: import("./event-bus.js").EventBus;
  fsWatcher?: FSWatcherAPI;
}

export type ScriptContext = BrainContext;

// ─── FSWatcher ───

export interface WatchRegistration {
  id: string;
  dispose(): void;
}

export interface FSChangeEvent {
  type: "create" | "modify" | "delete";
  path: string;
  isDir: boolean;
}

export type FSHandler = (event: FSChangeEvent) => void | Promise<void>;

export interface FSWatcherAPI {
  register(pattern: RegExp, handler: FSHandler, opts?: { debounceMs?: number; ownerId?: string }): WatchRegistration;
  unregisterOwner(ownerId: string): void;
  close(): void;
}
