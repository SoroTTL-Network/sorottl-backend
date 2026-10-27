/**
 * Options for transient error retry execution.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  readonly maxAttempts?: number;
  /** Initial delay in milliseconds before the first retry (default: 200ms) */
  readonly initialDelayMs?: number;
  /** Maximum delay cap in milliseconds between retries (default: 2000ms) */
  readonly maxDelayMs?: number;
  /** Maximum total time allowed across all retries in milliseconds (default: 8000ms) */
  readonly maxTotalTimeoutMs?: number;
  /** Optional custom predicate to determine if an error is transient (retryable) */
  readonly isTransient?: (err: unknown) => boolean;
  /** Optional sleeper function (defaults to setTimeout-based promise) */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Determines whether a Soroban RPC error is transient and safe to retry.
 */
export function defaultIsTransientError(err: unknown): boolean {
  if (!err) return false;

  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

  // Network / timeout / socket resets
  if (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("network error") ||
    message.includes("fetch failed") ||
    message.includes("undici")
  ) {
    return true;
  }

  // HTTP status codes commonly indicating transient upstream load or restart
  // 429 Too Many Requests, 500 Internal, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
  if (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("server error")
  ) {
    return true;
  }

  // Check object status code if attached
  if (typeof err === "object" && err !== null) {
    const status =
      (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode;
    if (typeof status === "number" && (status === 429 || (status >= 500 && status <= 504))) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts Retry-After delay in milliseconds from an error if present.
 */
export function extractRetryAfterMs(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;

  const retryAfter =
    (err as { retryAfter?: number | string }).retryAfter ??
    (err as { headers?: { get?: (header: string) => string | null } }).headers?.get?.(
      "retry-after",
    );

  if (typeof retryAfter === "number" && !isNaN(retryAfter) && retryAfter > 0) {
    // If < 1000, likely in seconds (standard HTTP Retry-After)
    return retryAfter < 1000 ? retryAfter * 1000 : retryAfter;
  }

  if (typeof retryAfter === "string") {
    const parsedSec = Number(retryAfter);
    if (!isNaN(parsedSec) && parsedSec > 0) {
      return parsedSec * 1000;
    }
  }

  return null;
}

/**
 * Executes an async operation with bounded exponential backoff, jitter, and Retry-After handling.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const maxTotalTimeoutMs = options.maxTotalTimeoutMs ?? 8000;
  const isTransient = options.isTransient ?? defaultIsTransientError;
  const sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const startTime = Date.now();
  let attempt = 1;

  while (true) {
    try {
      return await operation(attempt);
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      const remainingTotalMs = maxTotalTimeoutMs - elapsedMs;

      // Do not retry if we exceeded max attempts or the error is not transient
      if (attempt >= maxAttempts || !isTransient(err) || remainingTotalMs <= 0) {
        throw err;
      }

      // Check for explicit Retry-After header/property
      const retryAfterMs = extractRetryAfterMs(err);
      let backoffMs: number;

      if (retryAfterMs !== null && retryAfterMs > 0) {
        backoffMs = Math.min(retryAfterMs, maxDelayMs);
      } else {
        // Exponential backoff: initialDelay * 2^(attempt - 1)
        const exponentialDelay = initialDelayMs * Math.pow(2, attempt - 1);
        // Add full jitter: random value between 0 and calculated delay
        const jitter = Math.random() * 0.5 + 0.5; // 50% - 100% factor
        backoffMs = Math.min(exponentialDelay * jitter, maxDelayMs);
      }

      // Ensure sleep does not exceed remaining total budget
      const sleepDuration = Math.min(backoffMs, remainingTotalMs);
      if (sleepDuration <= 0) {
        throw err;
      }

      await sleepFn(sleepDuration);
      attempt++;
    }
  }
}
