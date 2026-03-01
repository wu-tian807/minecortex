/** Core public primitives — imported by tools/, subscriptions/, slots/ */

// ─── Event System ───

export interface Event {
  source: string;       // e.g. "stdin", "heartbeat", "brain:architect", "tool:spawn_thought"
  type: string;         // e.g. "message", "tick", "block_break"
  payload: unknown;
  ts: number;
  priority?: number;    // 0=immediate, 1=normal(default), 2=low
  silent?: boolean;     // true = queue only, don't trigger processing
  steer?: boolean;      // true = interrupt current LLM call immediately
  contentless?: boolean; // true = trigger a turn without injecting a message
}

export interface EventQueueInterface {
  push(event: Event): void;
  drain(): Event[];
  pending(): number;
  hasSteerEvent(): boolean;
  onSteer(cb: () => void): { dispose(): void };
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

export interface BrainJson {
  model?: string | string[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  showThinking?: boolean;
  coalesceMs?: number;
  subscriptions?: CapabilitySelector;
  tools?: CapabilitySelector;
  slots?: CapabilitySelector;
  session?: { keepToolResults?: number; keepMedias?: number };
  env?: Record<string, string>;
  vars?: Record<string, string>;
  timezone?: string;
}

export interface MineclawConfig {
  defaults?: {
    model?: string;
  };
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

export interface ToolContext {
  brainId: string;
  signal: AbortSignal;
  emit: (event: Event) => void;
  brainBoard: BrainBoardAPI;
  slot: DynamicSlotAPI;
  pathManager: PathManagerAPI;
  terminalManager: TerminalManagerAPI;
  workspace: string;
  /** Register a background promise so the parent brain can await it on shutdown. */
  trackBackgroundTask?: (p: Promise<unknown>) => void;
  /** Logger for sub-agents to inherit real-time debug output. */
  logger?: import("./logger.js").Logger;
}

export interface DynamicSlotAPI {
  register(id: string, content: string): void;
  update(id: string, content: string): void;
  release(id: string): void;
  get(id: string): string | undefined;
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

export interface SourceContext {
  brainId: string;
  brainDir: string;
  config?: Record<string, unknown>;
  brainBoard: BrainBoardAPI;
  hooks: import("../hooks/types.js").BrainHooksAPI;
  onCommand?: (toolName: string, args: Record<string, string>, target?: string, reason?: string) => void;
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
  resolve(input: { path: string; brain?: string }, callerBrainId: string): string;
  checkPermission(absPath: string, op: "read" | "write", callerBrainId: string, evolve: boolean): boolean;
}

// ─── Terminal Manager ───

export interface TerminalInstance {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  brainId: string;
  startedAt: number;
  exitCode?: number;
  elapsedMs?: number;
  logFile: string;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  brainId: string;
  timeoutMs?: number;
}

export interface TerminalManagerAPI {
  exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  get(id: string): TerminalInstance | undefined;
  list(filter?: { brainId?: string; status?: string }): TerminalInstance[];
  kill(id: string): boolean;
  readOutput(id: string, opts?: { tail?: number }): string;
  cleanup(maxAge?: number): void;
}

export interface ExecResult {
  terminalId: string;
  stdout: string;
  exitCode?: number;
  backgrounded: boolean;
  hint?: string;
}

// ─── Brain Interface ───

export interface BrainInterface {
  id: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface ScriptContext {
  brainId: string;
  emit: (event: Event) => void;
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
