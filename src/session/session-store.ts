import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  isMediaContentPart,
  isMediaRefPart,
  type PathManagerAPI,
  type ContentPart,
  type SerializedPart,
} from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";
import {
  readCurrentSessionId,
  updateSessionPointerMeta,
  watchCurrentSessionId,
  writeCurrentSessionId,
} from "./session-pointer.js";

type SerializedMessage = Omit<LLMMessage, "content"> & {
  content: string | SerializedPart[];
};

export interface LoadedSession {
  sessionId: string;
  raw: string;
  messages: LLMMessage[];
  parseErrorLine: number | null;
}

export class SessionStore {
  private brainId: string;
  private pathManager: PathManagerAPI;
  private writeLock: Promise<unknown> = Promise.resolve();
  /** Last known session ID — used by the fs watcher to deduplicate switch events. */
  private _cachedSessionId: string | undefined;
  private _sessionWatcher: import("node:fs").FSWatcher | null = null;

  // ─── Internal callbacks ───────────────────────────────────────────────────
  //
  // Single injection point for the owning brain to react to session lifecycle
  // events.  Intentionally not a pub/sub bus — there is exactly one consumer
  // (the brain that owns this session), so a plain callback object is clearer.
  //
  // onSessionSwitch(newSid, lastContextUsage)
  //   Fired whenever the active session pointer changes.
  //   `lastContextUsage` is the sum of inputTokens+outputTokens from the last
  //   assistant message in the new session that carries usage data, or null for
  //   a brand-new empty session.
  //
  // onContextUsageChange(sessionId, usage)
  //   Fired after any write (appendMessages / replaceMessages) that includes at
  //   least one message with usage data.  Gives the brain a live update without
  //   having to poll or re-read the file.

  callbacks: {
    onSessionSwitch?: (newSid: string, lastContextUsage: number | null) => void;
    onContextUsageChange?: (sessionId: string, usage: number) => void;
  } = {};

  constructor(brainId: string, pathManager: PathManagerAPI) {
    this.brainId = brainId;
    this.pathManager = pathManager;
  }

  private sessionDir(sid: string): string {
    return join(this.pathManager.local(this.brainId).root(), "sessions", sid);
  }

  private messagesPath(sid: string): string {
    return join(this.sessionDir(sid), "messages.jsonl");
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeLock.catch(() => undefined).then(fn);
    this.writeLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeAtomic(path: string, content: string | Buffer): Promise<void> {
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, content);
    await rename(tempPath, path);
  }

  async writeRecoverySnapshot(sid: string, raw: string, reason: string): Promise<void> {
    const snapshotPath = join(
      this.sessionDir(sid),
      `messages.${Date.now()}.${reason}.bak.jsonl`,
    );
    await writeFile(snapshotPath, raw, "utf-8");
  }

  private async parseSessionLines(raw: string, sid: string): Promise<{
    messages: LLMMessage[];
    parseErrorLine: number | null;
  }> {
    const lines = raw.split("\n");
    const messages: LLMMessage[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      try {
        const serialized: SerializedMessage = JSON.parse(line);
        messages.push(await this.deserializeMessage(serialized, sid));
      } catch {
        return { messages, parseErrorLine: i + 1 };
      }
    }

    return { messages, parseErrorLine: null };
  }

  async currentSessionId(): Promise<string | null> {
    return readCurrentSessionId(this.pathManager, this.brainId);
  }

  async createSession(): Promise<string> {
    return this.withWriteLock(async () => {
      const sid = `s_${Date.now()}`;
      const dir = this.sessionDir(sid);
      await mkdir(dir, { recursive: true });
      await this.writeAtomic(this.messagesPath(sid), "");

      await mkdir(this.pathManager.local(this.brainId).root(), { recursive: true });
      await writeCurrentSessionId(this.pathManager, this.brainId, sid);

      // Brand-new empty session — no usage yet.
      // Update _cachedSessionId so the fs watcher doesn't re-fire when it sees
      // the session.json we just wrote.
      this._cachedSessionId = sid;
      this.callbacks.onSessionSwitch?.(sid, null);
      return sid;
    });
  }

  async loadSessionMessages(sid?: string): Promise<LoadedSession | null> {
    // Avoid reading a half-written jsonl while append/replace is in progress.
    await this.writeLock.catch(() => undefined);

    const id = sid ?? (await this.currentSessionId());
    if (!id) return null;

    let raw: string;
    try {
      raw = await readFile(this.messagesPath(id), "utf-8");
    } catch {
      console.warn(`[session] pointer dangling (${id}), messages file is missing`);
      return null;
    }

    const { messages, parseErrorLine } = await this.parseSessionLines(raw, id);

    return { sessionId: id, raw, messages, parseErrorLine };
  }

  async appendMessages(msgs: LLMMessage[], sid?: string): Promise<void> {
    if (msgs.length === 0) return;

    await this.withWriteLock(async () => {
      const id = await this.ensureSessionForWrite(sid);
      const serialized = msgs.map((msg) => this.serializeMessage(msg));
      const content = serialized.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
      await appendFile(this.messagesPath(id), content, "utf-8");

      // Notify after the write so the brain can update its context-usage tracker.
      const usage = this.lastUsageFrom(msgs);
      if (usage !== null) this.callbacks.onContextUsageChange?.(id, usage);
    });
  }

  async replaceMessages(sid: string, messages: LLMMessage[]): Promise<void> {
    await this.withWriteLock(async () => {
      if (messages.length === 0) {
        await this.writeAtomic(this.messagesPath(sid), "");
        return;
      }

      const serialized = messages.map((msg) => this.serializeMessage(msg));
      const content = serialized.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
      await this.writeAtomic(this.messagesPath(sid), content);

      // replaceMessages is used by compact (newSession) and repair — notify if there is usage.
      const usage = this.lastUsageFrom(messages);
      if (usage !== null) this.callbacks.onContextUsageChange?.(sid, usage);
    });
  }

  /**
   * Immediately read the current session from disk and fire onSessionSwitch with the
   * derived lastContextUsage.  Call this once on brain startup so the status bar shows
   * the correct value before the first LLM call arrives.
   */
  async forceSync(): Promise<void> {
    const id = await this.currentSessionId();
    if (!id) return;
    // Use an explicit sid so the implicit-switch detection in loadSessionMessages is skipped;
    // we then fire onSessionSwitch manually with the computed usage.
    const loaded = await this.loadSessionMessages(id);
    const usage = this.lastUsageFrom(loaded?.messages ?? []);
    this._cachedSessionId = id;
    this.callbacks.onSessionSwitch?.(id, usage);
  }

  /**
   * Watch session.json for external changes (e.g. user switching sessions via the
   * renderer while the brain is idle).  Fires onSessionSwitch whenever the
   * currentSessionId actually changes — without needing an in-flight agent loop.
   */
  startWatch(): void {
    if (this._sessionWatcher) return;
    this._sessionWatcher = watchCurrentSessionId({
      pathManager: this.pathManager,
      brainId: this.brainId,
      initialSessionId: this._cachedSessionId,
      debounceMs: 100,
      onChange: (sid) => {
        this._cachedSessionId = sid;
        this.handleSessionChange(sid).catch(() => {});
      },
    });
  }

  private async handleSessionChange(id: string): Promise<void> {
    const loaded = await this.loadSessionMessages(id);
    const usage = this.lastUsageFrom(loaded?.messages ?? []);
    this.callbacks.onSessionSwitch?.(id, usage);
  }

  /** Extract the last inputTokens+outputTokens sum from a message list, or null. */
  private lastUsageFrom(messages: LLMMessage[]): number | null {
    const last = [...messages].reverse().find(m => m.usage);
    if (!last?.usage) return null;
    return last.usage.inputTokens + last.usage.outputTokens;
  }

  /** Merge arbitrary fields into session.json without clobbering unrelated keys. */
  async updateSessionMeta(updates: Record<string, unknown>): Promise<void> {
    await this.withWriteLock(async () => {
      const sid = await this.currentSessionId();
      await updateSessionPointerMeta(this.pathManager, this.brainId, {
        currentSessionId: sid ?? "",
        ...updates,
      });
    });
  }

  async updateResponseApiState(lastResponseId: string, provider: string): Promise<void> {
    await this.updateSessionMeta({ responseApi: { lastResponseId, provider } });
  }

  async newSession(initialMessages?: LLMMessage[]): Promise<string> {
    const sid = await this.createSession();
    if (initialMessages?.length) {
      await this.replaceMessages(sid, initialMessages);
    }
    return sid;
  }

  async resetSession(): Promise<void> {
    const id = await this.currentSessionId();
    if (!id) throw new Error("No active session to reset");
    await this.replaceMessages(id, []);
  }

  async resolveMessagesPath(sid?: string): Promise<string | null> {
    const id = sid ?? (await this.currentSessionId());
    if (!id) return null;
    return this.messagesPath(id);
  }

  private async ensureSessionForWrite(sid?: string): Promise<string> {
    let id = sid ?? (await this.currentSessionId());
    if (!id) {
      id = `s_${Date.now()}`;
      const dir = this.sessionDir(id);
      await mkdir(dir, { recursive: true });
      await this.writeAtomic(this.messagesPath(id), "");
      await mkdir(this.pathManager.local(this.brainId).root(), { recursive: true });
      await writeCurrentSessionId(this.pathManager, this.brainId, id);
    }
    return id;
  }

  private serializeMessage(msg: LLMMessage): SerializedMessage {
    if (typeof msg.content === "string") {
      return { ...msg } as SerializedMessage;
    }
    // All media is stored inline as base64. medias/ folder is only for renderer display cache.
    return { ...msg, content: msg.content as SerializedPart[] } as SerializedMessage;
  }

  private async deserializeMessage(msg: SerializedMessage, sid: string): Promise<LLMMessage> {
    if (typeof msg.content === "string") {
      return msg as LLMMessage;
    }

    const parts: ContentPart[] = [];
    for (const part of msg.content) {
      if (isMediaRefPart(part)) {
        const mediaType = part.type.replace("_ref", "") as "image" | "video" | "audio";
        try {
          const absPath = join(this.sessionDir(sid), part.path);
          const buf = await readFile(absPath);
          parts.push({ type: mediaType, data: buf.toString("base64"), mimeType: part.mimeType } as ContentPart);
        } catch {
          parts.push({ type: "text", text: `[${mediaType} unavailable: ${part.path}]` });
        }
      } else {
        parts.push(part as ContentPart);
      }
    }

    return { ...msg, content: parts } as LLMMessage;
  }
}
