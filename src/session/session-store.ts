import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  isMediaContentPart,
  isMediaRefPart,
  type PathManagerAPI,
  type ContentPart,
  type SerializedPart,
} from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";

const MEDIA_INLINE_THRESHOLD = 50 * 1024; // 50KB

interface SessionJson {
  currentSessionId: string;
  responseApi?: { lastResponseId: string; provider: string };
}

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

  constructor(brainId: string, pathManager: PathManagerAPI) {
    this.brainId = brainId;
    this.pathManager = pathManager;
  }

  private sessionJsonPath(): string {
    return join(this.pathManager.brainDir(this.brainId), "session.json");
  }

  private sessionDir(sid: string): string {
    return join(this.pathManager.brainDir(this.brainId), "sessions", sid);
  }

  private messagesPath(sid: string): string {
    return join(this.sessionDir(sid), "messages.jsonl");
  }

  private mediasDir(sid: string): string {
    return join(this.sessionDir(sid), "medias");
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
    try {
      const raw = await readFile(this.sessionJsonPath(), "utf-8");
      const data: SessionJson = JSON.parse(raw);
      return data.currentSessionId ?? null;
    } catch {
      return null;
    }
  }

  async createSession(): Promise<string> {
    return this.withWriteLock(async () => {
      const sid = `s_${Date.now()}`;
      const dir = this.sessionDir(sid);
      await mkdir(dir, { recursive: true });
      await this.writeAtomic(this.messagesPath(sid), "");

      const sessionJson: SessionJson = { currentSessionId: sid };
      await mkdir(join(this.pathManager.brainDir(this.brainId)), { recursive: true });
      await this.writeAtomic(this.sessionJsonPath(), JSON.stringify(sessionJson, null, 2));

      return sid;
    });
  }

  async loadSessionMessages(sid?: string): Promise<LoadedSession | null> {
    const id = sid ?? (await this.currentSessionId());
    if (!id) return null;

    let raw: string;
    try {
      raw = await readFile(this.messagesPath(id), "utf-8");
    } catch {
      console.warn(`[session] pointer dangling (${id}), auto-creating new session`);
      await this.createSession();
      return null;
    }

    const { messages, parseErrorLine } = await this.parseSessionLines(raw, id);
    return { sessionId: id, raw, messages, parseErrorLine };
  }

  async appendMessages(msgs: LLMMessage[], sid?: string): Promise<void> {
    if (msgs.length === 0) return;

    await this.withWriteLock(async () => {
      const id = await this.ensureSessionForWrite(sid);
      const serialized = await Promise.all(msgs.map((msg) => this.serializeMessage(msg, id)));
      const content = serialized.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
      await appendFile(this.messagesPath(id), content, "utf-8");
    });
  }

  async replaceMessages(sid: string, messages: LLMMessage[]): Promise<void> {
    await this.withWriteLock(async () => {
      if (messages.length === 0) {
        await this.writeAtomic(this.messagesPath(sid), "");
        return;
      }

      const serialized = await Promise.all(messages.map((msg) => this.serializeMessage(msg, sid)));
      const content = serialized.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
      await this.writeAtomic(this.messagesPath(sid), content);
    });
  }

  async updateResponseApiState(lastResponseId: string, provider: string): Promise<void> {
    await this.withWriteLock(async () => {
      let data: SessionJson;
      try {
        const raw = await readFile(this.sessionJsonPath(), "utf-8");
        data = JSON.parse(raw);
      } catch {
        const sid = await this.currentSessionId();
        data = { currentSessionId: sid ?? "" };
      }
      data.responseApi = { lastResponseId, provider };
      await this.writeAtomic(this.sessionJsonPath(), JSON.stringify(data, null, 2));
    });
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
      const sessionJson: SessionJson = { currentSessionId: id };
      await mkdir(join(this.pathManager.brainDir(this.brainId)), { recursive: true });
      await this.writeAtomic(this.sessionJsonPath(), JSON.stringify(sessionJson, null, 2));
    }
    return id;
  }

  private async serializeMessage(msg: LLMMessage, sid: string): Promise<SerializedMessage> {
    if (typeof msg.content === "string") {
      return { ...msg } as SerializedMessage;
    }

    const parts: SerializedPart[] = [];
    for (const part of msg.content) {
      if (isMediaContentPart(part)) {
        const byteSize = Buffer.byteLength(part.data, "base64");
        if (byteSize >= MEDIA_INLINE_THRESHOLD) {
          const mediaDir = this.mediasDir(sid);
          await mkdir(mediaDir, { recursive: true });
          const filename = `${Date.now()}_${randomBytes(4).toString("hex")}.${mimeToExt(part.mimeType)}`;
          const filePath = join(mediaDir, filename);
          await writeFile(filePath, Buffer.from(part.data, "base64"));
          const refType = `${part.type}_ref` as "image_ref" | "video_ref" | "audio_ref";
          parts.push({ type: refType, path: `medias/${filename}`, mimeType: part.mimeType });
        } else {
          parts.push(part);
        }
      } else {
        parts.push(part);
      }
    }

    return { ...msg, content: parts } as SerializedMessage;
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

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "weba",
    "audio/mp4": "m4a",
  };
  return map[mime] ?? "bin";
}
