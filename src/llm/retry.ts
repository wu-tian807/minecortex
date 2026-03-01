export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  retryableStatuses?: number[];
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    retryableStatuses = [429, 500, 502, 503],
  } = opts;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt >= maxRetries) throw err;
      if (err.name === "AbortError") throw err;

      const status = err?.status ?? err?.statusCode;
      if (status !== undefined && !retryableStatuses.includes(status)) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt); // 1s → 2s → 4s → 8s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
