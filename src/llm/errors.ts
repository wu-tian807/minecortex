/** LLM 错误分类与友好化消息 */

// ── 错误类型定义 ─────────────────────────────────────────

/** 终端错误（不重试） */
export class TerminalLLMError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "TerminalLLMError";
  }
}

/** 可重试错误 */
export class RetryableLLMError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryDelayMs?: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "RetryableLLMError";
  }
}

/** 网络错误（可重试子类） */
export class NetworkError extends RetryableLLMError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, undefined, cause);
    this.name = "NetworkError";
  }
}

// ── 常量定义 ─────────────────────────────────────────────

/** 可重试的 HTTP 状态码 */
export const RETRYABLE_STATUSES = [429, 500, 502, 503, 529];

/** 终端 HTTP 状态码（客户端错误，不重试） */
export const TERMINAL_STATUSES = [400, 401, 403, 404, 405, 422];

/** 可重试的网络错误码 */
export const RETRYABLE_NETWORK_CODES = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPROTO",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
];

/** 可重试的错误消息模式 */
const RETRYABLE_MESSAGE_PATTERN =
  /fetch failed|network|socket hang up|overloaded|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i;

// ── 错误分类 ─────────────────────────────────────────────

export type ClassifiedError =
  | { kind: "terminal"; error: TerminalLLMError }
  | { kind: "retryable"; error: RetryableLLMError }
  | { kind: "unknown"; error: Error };

/** 从错误对象提取 HTTP 状态码 */
function getStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  return undefined;
}

/** 从错误对象提取网络错误码 */
function getErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "string") return e.code;
  // 遍历 cause 链
  if (e.cause) return getErrorCode(e.cause);
  return undefined;
}

/** 从错误对象提取消息 */
function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** 从错误对象提取 retryDelayMs（如果 API 返回了 Retry-After） */
function getRetryDelay(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.retryAfterMs === "number") return e.retryAfterMs;
  if (typeof e.retryDelayMs === "number") return e.retryDelayMs;
  return undefined;
}

/**
 * 分类 LLM 调用错误
 * - terminal: 不应重试（认证失败、参数错误等）
 * - retryable: 应该重试（速率限制、服务过载、网络错误等）
 * - unknown: 无法分类，默认不重试
 */
export function classifyLLMError(err: unknown): ClassifiedError {
  const message = getMessage(err);
  const status = getStatus(err);
  const code = getErrorCode(err);
  const retryDelay = getRetryDelay(err);
  const originalError = err instanceof Error ? err : new Error(message);

  // 1. AbortError 永不重试
  if (err instanceof Error && err.name === "AbortError") {
    return {
      kind: "terminal",
      error: new TerminalLLMError("请求已取消", "ABORT", originalError),
    };
  }

  // 2. 检查网络错误码
  if (code && RETRYABLE_NETWORK_CODES.includes(code)) {
    return {
      kind: "retryable",
      error: new NetworkError(
        formatNetworkError(code, message),
        code,
        originalError,
      ),
    };
  }

  // 3. 检查 HTTP 状态码
  if (status !== undefined) {
    if (TERMINAL_STATUSES.includes(status)) {
      return {
        kind: "terminal",
        error: new TerminalLLMError(
          formatStatusError(status, message),
          `HTTP_${status}`,
          originalError,
        ),
      };
    }
    if (RETRYABLE_STATUSES.includes(status)) {
      return {
        kind: "retryable",
        error: new RetryableLLMError(
          formatStatusError(status, message),
          `HTTP_${status}`,
          retryDelay,
          originalError,
        ),
      };
    }
  }

  // 4. 检查错误消息模式
  if (RETRYABLE_MESSAGE_PATTERN.test(message)) {
    return {
      kind: "retryable",
      error: new NetworkError(
        formatNetworkError(code ?? "NETWORK", message),
        code ?? "NETWORK",
        originalError,
      ),
    };
  }

  // 5. 无法分类
  return {
    kind: "unknown",
    error: originalError,
  };
}

// ── 友好化错误消息 ───────────────────────────────────────

/** 格式化网络错误消息 */
function formatNetworkError(code: string, original: string): string {
  switch (code) {
    case "ECONNREFUSED":
      return `无法连接到 API 服务器。请检查网络或 API 地址配置。`;
    case "ECONNRESET":
      return `与 API 服务器的连接被重置。正在重试...`;
    case "ETIMEDOUT":
      return `连接 API 服务器超时。正在重试...`;
    case "ENOTFOUND":
      return `无法解析 API 服务器地址。请检查网络连接。`;
    case "EAI_AGAIN":
      return `DNS 解析临时失败。正在重试...`;
    case "EPIPE":
      return `与 API 服务器的连接意外断开。正在重试...`;
    case "EPROTO":
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC":
      return `SSL/TLS 连接错误。正在重试...`;
    default:
      if (/fetch failed/i.test(original)) {
        return `网络连接失败。请检查网络连接后重试。`;
      }
      return original;
  }
}

/** 格式化 HTTP 状态错误消息 */
function formatStatusError(status: number, original: string): string {
  switch (status) {
    case 400:
      return `API 请求参数错误: ${original}`;
    case 401:
      return `API 认证失败。请检查 key/llm_key.json 中的 api_key 配置。`;
    case 403:
      return `API 权限不足。请检查 API key 权限或配额。`;
    case 404:
      return `API 端点不存在。请检查模型名称或 API 地址配置。`;
    case 429:
      return `API 请求频率超限，稍后重试...`;
    case 500:
      return `API 服务器内部错误，正在重试...`;
    case 502:
      return `API 网关错误，正在重试...`;
    case 503:
      return `API 服务暂时不可用，正在重试...`;
    case 529:
      return `API 服务暂时过载 (Anthropic overloaded)，正在重试...`;
    default:
      return `API 错误 (HTTP ${status}): ${original}`;
  }
}

/**
 * 格式化 LLM 错误为友好消息
 * 直接使用 classifyLLMError 的结果
 */
export function formatLLMError(err: unknown): string {
  const classified = classifyLLMError(err);
  return classified.error.message;
}

/**
 * 判断错误是否可重试
 */
export function isRetryable(err: unknown): boolean {
  const classified = classifyLLMError(err);
  return classified.kind === "retryable";
}

/**
 * 获取建议的重试延迟（如果错误中包含）
 */
export function getRecommendedDelay(err: unknown): number | undefined {
  const classified = classifyLLMError(err);
  if (classified.kind === "retryable" && classified.error instanceof RetryableLLMError) {
    return classified.error.retryDelayMs;
  }
  return undefined;
}
