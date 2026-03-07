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
  tokensPerChar: number;
}

// ─── Brain Config ───

export interface CapabilitySelector {
  global: "all" | "none";
  enable?: string[];
  disable?: string[];
  config?: Record<string, Record<string, unknown>>;
}

export interface CapabilityPathRedirects {
  tools?: string;
  slots?: string;
  subscriptions?: string;
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
  paths?: CapabilityPathRedirects;

  /** Session 压缩配置 */
  session?: {
    /** 微压缩保留最近 N 个 tool_result，默认 8 */
    keepToolResults?: number;
    /** 微压缩保留最近 N 个多媒体消息，默认 2 */
    keepMedias?: number;
  };

  /** 环境变量（注入到 shell 执行环境） */
  env?: Record<string, string>;

  /** 时区，默认 Asia/Shanghai */
  timezone?: string;
}

export interface MineclawConfig {
  /** 全局模型配置 */
  models?: ModelsConfig;
}

// ─── Tool System ───

export type ToolOutput = string | ContentPart[];

export interface ToolDefinition {
  name: string;
  description: string;
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

export interface ToolContext {
  brainId: string;
  signal: AbortSignal;
  eventBus: EventBusAPI;
  brainBoard: BrainBoardAPI;
  slot: DynamicSlotAPI;
  tools: DynamicToolAPI;
  subscriptions: DynamicSubscriptionAPI;
  pathManager: PathManagerAPI;
  workspace: string;
  /** Register a background promise so the parent brain can await it on shutdown. */
  trackBackgroundTask?: (p: Promise<unknown>) => void;
  /** Logger for sub-agents to inherit real-time debug output. */
  logger?: import("./logger.js").Logger;
}

// ─── BrainBoard (reactive state registry) ───

export type WatchCallback = (value: unknown, prev: unknown) => void;

export interface BrainBoardAPI {
  set(brainId: string, key: string, value: unknown): void;
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

// ─── EventSource (pluggable subscription, factory pattern) ───

/** Brain 暴露给 Subscription 的能力接口 */
export interface BrainContextAPI {
  readonly id: string;
  readonly brainDir: string;
  readonly hooks: import("../hooks/types.js").BrainHooksAPI;
  readonly brainBoard: BrainBoardAPI;
  readonly pathManager: PathManagerAPI;
  readonly eventBus: EventBusAPI;
  queueCommand(toolName: string, args: Record<string, string>, reason?: string): void;
}

export interface SourceContext {
  brain: BrainContextAPI;
  eventConfig?: Record<string, unknown>;
}

export type EventSourceFactory = (ctx: SourceContext) => EventSource;

export interface EventSource {
  name: string;
  start(emit: (event: Event) => void): void;
  stop(): void;
}

// ─── PathManager ───

export interface PathManagerAPI {
  root(): string;
  dir(name: string): string;
  brainDir(brainId: string): string;
  logsDir(brainId?: string): string;
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
  brainId: string;
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
  brainId: string;
  timeoutMs?: number;
}

export interface TerminalManagerAPI {
  exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  get(id: string): TerminalInstance | undefined;
  list(filter?: { brainId?: string; status?: string }): TerminalInstance[];
  kill(id: string): boolean;
  cleanup(maxAge?: number): void;
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
}

export interface ScriptContext {
  brainId: string;
  eventBus: EventBusAPI;
  brainBoard: BrainBoardAPI;
}

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
  register(pattern: RegExp, handler: FSHandler, opts?: { debounceMs?: number }): WatchRegistration;
  close(): void;
}
