import type {
  LLMMessage,
  LLMResponse,
  StreamChunk,
  LLMToolCall,
  ProviderSidecarData,
} from "./types.js";

function mergeProviderSidecarData(
  current: ProviderSidecarData | undefined,
  incoming: ProviderSidecarData | undefined,
): ProviderSidecarData | undefined {
  if (!incoming) return current;
  if (!current) return { ...incoming };
  return { ...current, ...incoming };
}

class ResponseAccumulator {
  private text = "";
  private thinking = "";
  private readonly toolCalls: LLMToolCall[] = [];
  private usage: { inputTokens: number; outputTokens: number; thinkingTokens?: number } | undefined;
  private providerSidecarData: ProviderSidecarData | undefined;

  addChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case "text":
        this.text += chunk.text;
        this.providerSidecarData = mergeProviderSidecarData(
          this.providerSidecarData,
          chunk.providerSidecarData,
        );
        break;
      case "thinking":
        this.thinking += chunk.text;
        this.providerSidecarData = mergeProviderSidecarData(
          this.providerSidecarData,
          chunk.providerSidecarData,
        );
        break;
      case "tool_call": {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(chunk.arguments);
        } catch {}
        this.toolCalls.push({
          id: chunk.id,
          name: chunk.name,
          arguments: args,
          providerSidecarData: chunk.providerSidecarData,
        });
        break;
      }
      case "provider_sidecar":
        this.providerSidecarData = mergeProviderSidecarData(
          this.providerSidecarData,
          chunk.providerSidecarData,
        );
        break;
      case "usage":
        this.usage = {
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
          thinkingTokens: chunk.thinkingTokens,
        };
        break;
    }
  }

  buildResponse(truncated?: boolean): LLMResponse {
    return {
      content: this.text,
      thinking: this.thinking || undefined,
      toolCalls: this.toolCalls.length > 0 ? this.toolCalls : undefined,
      usage: this.usage,
      providerSidecarData: this.providerSidecarData,
      ...(truncated ? { truncated: true } : {}),
    };
  }
}

export class LLMStreamError extends Error {
  partialResponse?: LLMResponse;

  constructor(message: string, options?: { cause?: unknown; partialResponse?: LLMResponse }) {
    super(message);
    this.name = "LLMStreamError";
    this.cause = options?.cause;
    this.partialResponse = options?.partialResponse;
  }
}

export function getPartialResponse(error: unknown): LLMResponse | undefined {
  return error instanceof LLMStreamError ? error.partialResponse : undefined;
}

export function responseToAssistantMessage(
  response: LLMResponse,
  options: { showThinking: boolean; ts: number; truncated?: boolean },
): LLMMessage {
  return {
    role: "assistant",
    content: response.content,
    thinking: options.showThinking ? response.thinking : undefined,
    toolCalls: response.toolCalls,
    usage: response.usage
      ? {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        }
      : undefined,
    providerSidecarData: response.providerSidecarData,
    ...(options.truncated ? { truncated: true } : {}),
    ts: options.ts,
  };
}

/** Collect an async stream of chunks into a single LLMResponse. */
export async function assembleResponse(
  stream: AsyncIterable<StreamChunk>,
): Promise<LLMResponse> {
  const accumulator = new ResponseAccumulator();

  for await (const chunk of stream) {
    accumulator.addChunk(chunk);
  }

  return accumulator.buildResponse();
}

/** Collect stream with per-chunk callback for streaming hooks.
 *  If the stream is aborted mid-flight, returns whatever was accumulated so far
 *  with `truncated: true` instead of throwing, so callers can persist partial output. */
export async function assembleResponseWithCallback(
  stream: AsyncIterable<StreamChunk>,
  onChunk?: (chunk: StreamChunk) => void,
): Promise<LLMResponse> {
  const accumulator = new ResponseAccumulator();

  try {
    for await (const chunk of stream) {
      onChunk?.(chunk);
      accumulator.addChunk(chunk);
    }
  } catch (err: any) {
    // AbortError: return whatever we managed to collect rather than discarding it.
    if (err?.name === "AbortError" || err?.code === "ERR_ABORTED" || err?.message === "aborted") {
      return accumulator.buildResponse(true);
    }
    throw new LLMStreamError(err?.message ?? "LLM stream failed", {
      cause: err,
      partialResponse: accumulator.buildResponse(true),
    });
  }

  return accumulator.buildResponse();
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
