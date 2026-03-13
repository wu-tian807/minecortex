import type { PathManagerAPI } from "../core/types.js";
import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import {
  buildPersistentHistoryRepair,
  normalizeHistory,
} from "./history-normalizer.js";
import {
  preparePromptHistory,
  type PromptHistoryOptions,
} from "./session-history.js";
import { SessionStore, type LoadedSession } from "./session-store.js";
import {
  createPendingToolMessages,
  createToolResultMessage,
  type ToolLifecycleSink,
} from "./tool-normalizer.js";

export { preparePromptHistory } from "./session-history.js";

export interface NormalizedSession {
  sessionId: string;
  raw: string;
  messages: LLMMessage[];
  parseErrorLine: number | null;
  changed: boolean;
  needsPersistentRepair: boolean;
}

export class SessionManager implements ToolLifecycleSink {
  private store: SessionStore;

  constructor(brainId: string, pathManager: PathManagerAPI) {
    this.store = new SessionStore(brainId, pathManager);
  }

  async currentSessionId(): Promise<string | null> {
    return this.store.currentSessionId();
  }

  /**
   * Inject internal callbacks for session lifecycle events.
   * This is the single injection point for the owning brain — not a pub/sub bus.
   *
   * `onSessionSwitch` behaves like a BehaviorSubject: it fires once immediately
   * for the current session so the caller never needs a separate startup-sync call.
   */
  setCallbacks(cbs: {
    onSessionSwitch?: (newSid: string, lastContextUsage: number | null) => void;
    onContextUsageChange?: (sessionId: string, usage: number) => void;
  }): void {
    Object.assign(this.store.callbacks, cbs);
    if (cbs.onSessionSwitch) {
      // BehaviorSubject semantics: fire immediately for current session.
      this.store.forceSync().catch(() => {});
      // Also watch for external switches while the brain is idle.
      this.store.startWatch();
    }
  }

  async createSession(): Promise<string> {
    return this.store.createSession();
  }

  async loadRawSession(sid?: string): Promise<LoadedSession | null> {
    return this.store.loadSessionMessages(sid);
  }

  async loadNormalizedSession(sid?: string): Promise<NormalizedSession | null> {
    const loaded = await this.loadRawSession(sid);
    if (!loaded) return null;

    const normalized = normalizeHistory(loaded.messages);
    return {
      sessionId: loaded.sessionId,
      raw: loaded.raw,
      messages: normalized.messages,
      parseErrorLine: loaded.parseErrorLine,
      changed: normalized.changed,
      needsPersistentRepair: loaded.parseErrorLine != null || normalized.hasInterruptedToolCalls,
    };
  }

  async repairSession(sid?: string): Promise<LLMMessage[]> {
    const loaded = await this.loadRawSession(sid);
    if (!loaded) return [];

    const { sessionId, raw, messages, parseErrorLine } = loaded;
    if (parseErrorLine != null) {
      console.warn(`[session] parse error in ${sessionId} at line ${parseErrorLine}, truncating to last valid message`);
    }

    const repair = buildPersistentHistoryRepair(messages);
    const needsPersistentRepair = parseErrorLine != null || repair.needsRepair;
    if (needsPersistentRepair) {
      const label = parseErrorLine != null ? `parse-error-line-${parseErrorLine}` : "repair";
      await this.store.writeRecoverySnapshot(sessionId, raw, label);
      await this.store.replaceMessages(sessionId, repair.messages);
      return repair.messages;
    }

    return repair.changed ? repair.messages : messages;
  }

  async loadSession(sid?: string): Promise<LLMMessage[]> {
    const normalized = await this.loadNormalizedSession(sid);
    return normalized?.messages ?? [];
  }

  async loadSessionSnapshot(sid?: string): Promise<LoadedSession | null> {
    return this.loadRawSession(sid);
  }

  /** Narrow-typed alias for ToolContext.SessionManagerAPI — returns normalized messages. */
  async loadSnapshot(sid: string): Promise<{ messages: LLMMessage[] } | null> {
    const normalized = await this.loadNormalizedSession(sid);
    return normalized ? { messages: normalized.messages } : null;
  }

  async loadPromptHistory(options: PromptHistoryOptions = {}, sid?: string): Promise<LLMMessage[]> {
    const normalized = await this.loadNormalizedSession(sid);
    if (!normalized) return [];
    return preparePromptHistory(normalized.messages, options);
  }

  async appendMessage(msg: LLMMessage, sid?: string): Promise<void> {
    await this.appendMessages([msg], sid);
  }

  async appendMessages(msgs: LLMMessage[], sid?: string): Promise<void> {
    await this.store.appendMessages(msgs, sid);
  }

  async appendAssistantTurn(msg: LLMMessage, sid?: string): Promise<void> {
    await this.appendMessage(msg, sid);
  }

  async appendToolPendings(toolCalls: LLMToolCall[], sid?: string): Promise<void> {
    await this.appendMessages(createPendingToolMessages(toolCalls), sid);
  }

  async appendToolResult(
    toolCall: LLMToolCall,
    result: unknown,
    sid?: string,
  ): Promise<void> {
    await this.appendMessage(createToolResultMessage(toolCall, result), sid);
  }

  async updateSessionMeta(updates: Record<string, unknown>): Promise<void> {
    await this.store.updateSessionMeta(updates);
  }

  async updateResponseApiState(lastResponseId: string, provider: string): Promise<void> {
    await this.store.updateResponseApiState(lastResponseId, provider);
  }

  /** Create a new session with optional initial messages, switch the pointer. */
  async newSession(initialMessages?: LLMMessage[]): Promise<string> {
    return this.store.newSession(initialMessages);
  }

  /** Clear messages in the current session without creating a new directory. */
  async resetSession(): Promise<void> {
    await this.store.resetSession();
  }

  /** Resolve the messages.jsonl path for the current session (used by compact tool) */
  async resolveMessagesPath(sid?: string): Promise<string | null> {
    return this.store.resolveMessagesPath(sid);
  }
}
