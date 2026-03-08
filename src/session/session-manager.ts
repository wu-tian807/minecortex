import type { PathManagerAPI } from "../core/types.js";
import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import { repairToolPairing } from "./history-normalizer.js";
import {
  compactPromptHistory,
  preparePromptHistory,
  type PromptHistoryOptions,
} from "./session-history.js";
import { SessionStore, type LoadedSession } from "./session-store.js";
import {
  createPendingToolMessages,
  createToolResultMessage,
  type ToolLifecycleSink,
} from "./tool-lifecycle.js";

export { preparePromptHistory } from "./session-history.js";

export class SessionManager implements ToolLifecycleSink {
  private store: SessionStore;

  constructor(brainId: string, pathManager: PathManagerAPI) {
    this.store = new SessionStore(brainId, pathManager);
  }

  async currentSessionId(): Promise<string | null> {
    return this.store.currentSessionId();
  }

  async createSession(): Promise<string> {
    return this.store.createSession();
  }

  async loadSession(sid?: string): Promise<LLMMessage[]> {
    const loaded = await this.loadSessionSnapshot(sid);
    if (!loaded) {
      return [];
    }

    const { sessionId, raw, messages, parseErrorLine } = loaded;
    if (parseErrorLine != null) {
      console.warn(`[session] parse error in ${sessionId} at line ${parseErrorLine}, truncating to last valid message`);
    }

    const repaired = repairToolPairing(messages);
    const needsWrite = parseErrorLine != null || JSON.stringify(repaired) !== JSON.stringify(messages);
    if (needsWrite) {
      // Back up only for real anomalies (parse error or synthetic results injected
      // for dangling tool calls); routine `pending` cleanup doesn't need a backup.
      const isCritical = parseErrorLine != null || repaired.some((m) => m.toolStatus === "synthetic");
      if (isCritical) {
        const label = parseErrorLine != null ? `parse-error-line-${parseErrorLine}` : "repair";
        await this.store.writeRecoverySnapshot(sessionId, raw, label);
      }
      await this.store.replaceMessages(sessionId, repaired);
      return repaired;
    }

    return messages;
  }

  async loadSessionSnapshot(sid?: string): Promise<LoadedSession | null> {
    return this.store.loadSessionMessages(sid);
  }

  async loadPromptHistory(options: PromptHistoryOptions = {}, sid?: string): Promise<LLMMessage[]> {
    const messages = await this.loadSession(sid);
    return compactPromptHistory(messages, options);
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
