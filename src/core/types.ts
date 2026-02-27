/** @desc 框架核心类型定义 */

// ─── Event ───

export interface Event {
  source: string;       // e.g. "stdin", "minecraft-chat"
  type: string;         // e.g. "message", "block_break"
  payload: unknown;
  ts: number;
}

// ─── BrainBus ───

export interface BusMessage {
  from: string;
  to: string | "*";     // "*" = broadcast
  content: string;       // natural language message body
  summary: string;       // 5-10 word preview for logs/inbox
  ts: number;
}

// ─── Notice (unified accumulation unit) ───

export type NoticeKind = "event" | "bus";

export interface Notice {
  kind: NoticeKind;
  event?: Event;        // present when kind === "event"
  message?: BusMessage; // present when kind === "bus"
  ts: number;
}

export interface NoticeQueueInterface {
  push(notice: Notice): void;
  drain(): Notice[];
  pending(): number;
}

// ─── WakePolicy (per-brain, loaded from brains/<id>/wake.ts) ───

export interface WakeContext {
  pending: number;
}

export interface WakePolicy {
  shouldWake(notice: Notice, ctx?: WakeContext): boolean;
  heartbeatMs?: number;
  coalesceMs?: number;
}

// ─── Brain Config ───

export interface CapabilitySelector {
  default: "all" | "none";
  enable?: string[];
  disable?: string[];
}

export interface BrainJson {
  model?: string;
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
  brainBus: BrainBusInterface;
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

// ─── EventSource (pluggable subscription) ───

export interface EventSource {
  name: string;
  start(emit: (event: Event) => void): void;
  stop(): void;
}

// ─── BrainBus interface (for dependency injection) ───

export interface BrainBusInterface {
  send(msg: BusMessage): void;
  broadcast(from: string, content: string, summary: string): void;
  drain(brainId: string): BusMessage[];
  pending(brainId: string): number;
}

// ─── Brain interface ───

export interface BrainInterface {
  id: string;
  tick(): Promise<void>;
}
