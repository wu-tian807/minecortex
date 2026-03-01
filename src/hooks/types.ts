/** Lifecycle hook types — event-driven hooks for external injection via subscriptions */

import type { LLMMessage, LLMToolCall } from "../llm/types.js";

// ─── Hook Events ───

export enum HookEvent {
  AssistantMessage = "assistantMessage",
  TurnStart = "turnStart",
  TurnEnd = "turnEnd",
  ToolCall = "toolCall",
  ToolResult = "toolResult",
}

// ─── Payload per event ───

export interface HookPayloadMap {
  [HookEvent.AssistantMessage]: {
    msg: LLMMessage;
    turn: number;
  };
  [HookEvent.TurnStart]: {
    turn: number;
    eventCount: number;
  };
  [HookEvent.TurnEnd]: {
    turn: number;
    aborted: boolean;
  };
  [HookEvent.ToolCall]: {
    name: string;
    args: Record<string, unknown>;
    toolCall: LLMToolCall;
  };
  [HookEvent.ToolResult]: {
    name: string;
    result: unknown;
    durationMs: number;
  };
}

// ─── Callback signature (strongly typed per event) ───

export type HookCallback<E extends HookEvent> = (payload: HookPayloadMap[E]) => void;

// ─── Public API (exposed to subscriptions via SourceContext) ───

export interface BrainHooksAPI {
  on<E extends HookEvent>(event: E, cb: HookCallback<E>): () => void;
}
