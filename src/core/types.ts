/** @desc 框架核心类型定义 — Event 是唯一的信号原语 */

// ─── Event (唯一信号原语) ───

export interface Event {
  source: string;       // e.g. "stdin", "heartbeat", "brain:architect", "tool:spawn_thought"
  type: string;         // e.g. "message", "tick", "block_break"
  payload: unknown;
  ts: number;
  priority?: number;    // 0=immediate, 1=normal(default), 2=low
  silent?: boolean;     // true = queue only, don't trigger processing
}

// ─── EventQueue (per-brain 事件累积器) ───

export interface EventQueueInterface {
  push(event: Event): void;
  drain(): Event[];
  pending(): number;
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
  default: "all" | "none";
  enable?: string[];
  disable?: string[];
  config?: Record<string, Record<string, unknown>>;
}

export interface BrainJson {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  coalesceMs?: number;
  subscriptions?: CapabilitySelector;
  tools?: CapabilitySelector;
  skills?: CapabilitySelector;
  directives?: CapabilitySelector;
}

export interface MineclawConfig {
  defaults?: {
    model?: string;
  };
}

// ─── Directive (指令模块: .ts 配置 + .md 内容) ───

export interface DirectiveConfig {
  name: string;
  order: number;
  condition?: (ctx: DirectiveContext) => boolean;
  variables?: string[];
}

export interface DirectiveContext {
  brainId: string;
  hasTools: boolean;
  hasSubscriptions: boolean;
  [key: string]: unknown;
}

export interface LoadedDirective {
  config: DirectiveConfig;
  content: string;
}

// ─── Tool ───

export interface ToolParameter {
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  brainId: string;
  emit: (event: Event) => void;
  readState: (targetBrainId: string) => Promise<Record<string, unknown>>;
}

// ─── LLM ───

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls?: LLMToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProviderInterface {
  chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse>;
}

// ─── EventSource (pluggable subscription, factory pattern) ───

export interface SourceContext {
  brainId: string;
  brainDir: string;
  config?: Record<string, unknown>;
}

export type EventSourceFactory = (ctx: SourceContext) => EventSource;

export interface EventSource {
  name: string;
  start(emit: (event: Event) => void): void;
  stop(): void;
}

// ─── Brain interface ───

export interface BrainInterface {
  id: string;
  run(signal: AbortSignal): Promise<void>;
}
