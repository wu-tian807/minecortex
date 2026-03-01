import type { LLMResponse, StreamChunk, LLMToolCall } from "./types.js";

/** Collect an async stream of chunks into a single LLMResponse. */
export async function assembleResponse(
  stream: AsyncIterable<StreamChunk>,
): Promise<LLMResponse> {
  let text = "";
  let thinking = "";
  const toolCalls: LLMToolCall[] = [];
  let usage: { inputTokens: number; outputTokens: number; thinkingTokens?: number } | undefined;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "text":
        text += chunk.text;
        break;
      case "thinking":
        thinking += chunk.text;
        break;
      case "tool_call": {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(chunk.arguments);
        } catch {}
        toolCalls.push({ id: chunk.id, name: chunk.name, arguments: args });
        break;
      }
      case "usage":
        usage = {
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
          thinkingTokens: chunk.thinkingTokens,
        };
        break;
    }
  }

  return {
    content: text,
    thinking: thinking || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

// ── <think> tag state-machine parser: NORMAL → IN_THINK → NORMAL ──

type ThinkState = "NORMAL" | "IN_THINK";

export class ThinkTagParser {
  private state: ThinkState = "NORMAL";
  private buffer = "";

  *feed(text: string): Generator<StreamChunk> {
    this.buffer += text;

    while (this.buffer.length > 0) {
      if (this.state === "NORMAL") {
        const idx = this.buffer.indexOf("<think>");
        if (idx === -1) {
          const partial = this.partialMatch(this.buffer, "<think>");
          if (partial >= 0) {
            const safe = this.buffer.slice(0, partial);
            if (safe) yield { type: "text", text: safe };
            this.buffer = this.buffer.slice(partial);
            return;
          }
          yield { type: "text", text: this.buffer };
          this.buffer = "";
        } else {
          if (idx > 0) yield { type: "text", text: this.buffer.slice(0, idx) };
          this.buffer = this.buffer.slice(idx + 7);
          this.state = "IN_THINK";
        }
      } else {
        const idx = this.buffer.indexOf("</think>");
        if (idx === -1) {
          const partial = this.partialMatch(this.buffer, "</think>");
          if (partial >= 0) {
            const safe = this.buffer.slice(0, partial);
            if (safe) yield { type: "thinking", text: safe };
            this.buffer = this.buffer.slice(partial);
            return;
          }
          yield { type: "thinking", text: this.buffer };
          this.buffer = "";
        } else {
          if (idx > 0) yield { type: "thinking", text: this.buffer.slice(0, idx) };
          this.buffer = this.buffer.slice(idx + 8);
          this.state = "NORMAL";
        }
      }
    }
  }

  *flush(): Generator<StreamChunk> {
    if (this.buffer) {
      yield {
        type: this.state === "IN_THINK" ? "thinking" : "text",
        text: this.buffer,
      } as StreamChunk;
      this.buffer = "";
    }
  }

  private partialMatch(buf: string, tag: string): number {
    for (let i = 1; i < tag.length; i++) {
      if (buf.endsWith(tag.slice(0, i))) return buf.length - i;
    }
    return -1;
  }
}

// ── SSE event parser for streaming HTTP responses ──

export async function* parseSSE(
  response: Response,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;

        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let event: string | undefined;
        const dataLines: string[] = [];

        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (dataLines.length > 0) {
          yield { event, data: dataLines.join("\n") };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
