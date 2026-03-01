import { readFile, writeFile, appendFile, mkdir, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { PathManagerAPI, ContentPart, SerializedPart } from "../core/types.js";
import type { LLMMessage } from "../llm/types.js";

const MEDIA_INLINE_THRESHOLD = 50 * 1024; // 50KB

interface SessionJson {
  currentSessionId: string;
  responseApi?: { lastResponseId: string; provider: string };
}

type SerializedMessage = Omit<LLMMessage, "content"> & {
  content: string | SerializedPart[];
};

export class SessionManager {
  private brainId: string;
  private pathManager: PathManagerAPI;

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
    const sid = `s_${Date.now()}`;
    const dir = this.sessionDir(sid);
    await mkdir(dir, { recursive: true });
    await writeFile(this.messagesPath(sid), "", "utf-8");

    const sessionJson: SessionJson = { currentSessionId: sid };
    await mkdir(join(this.pathManager.brainDir(this.brainId)), { recursive: true });
    await writeFile(this.sessionJsonPath(), JSON.stringify(sessionJson, null, 2), "utf-8");

    return sid;
  }

  async loadSession(sid?: string): Promise<LLMMessage[]> {
    const id = sid ?? (await this.currentSessionId());
    if (!id) return [];

    let raw: string;
    try {
      raw = await readFile(this.messagesPath(id), "utf-8");
    } catch {
      return [];
    }

    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    const messages: LLMMessage[] = [];

    for (const line of lines) {
      const serialized: SerializedMessage = JSON.parse(line);
      messages.push(await this.deserializeMessage(serialized, id));
    }

    return messages;
  }

  async appendMessage(msg: LLMMessage, sid?: string): Promise<void> {
    const id = sid ?? (await this.currentSessionId());
    if (!id) throw new Error("No active session");

    const serialized = await this.serializeMessage(msg, id);
    const line = JSON.stringify(serialized) + "\n";
    await appendFile(this.messagesPath(id), line, "utf-8");
  }

  async updateResponseApiState(lastResponseId: string, provider: string): Promise<void> {
    let data: SessionJson;
    try {
      const raw = await readFile(this.sessionJsonPath(), "utf-8");
      data = JSON.parse(raw);
    } catch {
      const sid = await this.currentSessionId();
      data = { currentSessionId: sid ?? "" };
    }
    data.responseApi = { lastResponseId, provider };
    await writeFile(this.sessionJsonPath(), JSON.stringify(data, null, 2), "utf-8");
  }

  /** Resolve the messages.jsonl path for the current session (used by compact tool) */
  async resolveMessagesPath(sid?: string): Promise<string | null> {
    const id = sid ?? (await this.currentSessionId());
    if (!id) return null;
    return this.messagesPath(id);
  }

  private async serializeMessage(msg: LLMMessage, sid: string): Promise<SerializedMessage> {
    if (typeof msg.content === "string") {
      return { ...msg } as SerializedMessage;
    }

    const parts: SerializedPart[] = [];
    for (const part of msg.content) {
      if (part.type === "image") {
        const byteSize = Buffer.byteLength(part.data, "base64");
        if (byteSize >= MEDIA_INLINE_THRESHOLD) {
          const mediaDir = this.mediasDir(sid);
          await mkdir(mediaDir, { recursive: true });
          const filename = `${Date.now()}_${randomBytes(4).toString("hex")}.${mimeToExt(part.mimeType)}`;
          const filePath = join(mediaDir, filename);
          await writeFile(filePath, Buffer.from(part.data, "base64"));
          parts.push({ type: "image_ref", path: `medias/${filename}`, mimeType: part.mimeType });
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
      if (part.type === "image_ref") {
        try {
          const absPath = join(this.sessionDir(sid), part.path);
          const buf = await readFile(absPath);
          parts.push({ type: "image", data: buf.toString("base64"), mimeType: part.mimeType });
        } catch {
          parts.push({ type: "text", text: `[image unavailable: ${part.path}]` });
        }
      } else {
        parts.push(part);
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
  };
  return map[mime] ?? "bin";
}
