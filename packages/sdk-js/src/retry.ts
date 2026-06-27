/**
 * Generic retry engine for transient failures.
 *
 * {@link withRetry} runs `fn`, and on a thrown error consults the {@link RetryPolicy}
 * to decide whether to retry, how long to wait, and stops after `maxRetries`
 * retries (re-throwing the last error). It is the **single** retry implementation
 * in the SDK: {@link SmscodeClient.request} delegates its transient-failure retry
 * to this function, and `orders.create` rides that same path, so there is exactly
 * one place that owns "wait and try again".
 *
 * The wait is `retryAfter(err)` (a server `Retry-After`, in **seconds**) when
 * present, otherwise capped exponential backoff with jitter. Both the wait clock
 * (`sleep`) and the backoff (`delayMs`) are injectable so tests stay instant and
 * deterministic.
 */

/** A policy that decides whether/how to retry a failed attempt. */
export interface RetryPolicy {
  /** Maximum number of *retries* (so total attempts = `maxRetries + 1`). */
  maxRetries: number;
  /** Whether a given thrown error is worth retrying. */
  retryOn: (err: unknown) => boolean;
  /**
   * Seconds to wait before the next retry, sourced from the error (e.g. a
   * `Retry-After` header). Returns `undefined` to fall back to backoff.
   */
  retryAfter?: (err: unknown) => number | undefined;
  /**
   * Backoff for retry attempt `n` (1-based) in milliseconds, used when
   * `retryAfter` yields nothing. Defaults to capped exponential backoff + jitter.
   */
  delayMs?: (attempt: number) => number;
  /** The wait clock. Defaults to a real `setTimeout`-backed sleep. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Base backoff step (ms). The first retry waits ~this, doubling each step. */
const BACKOFF_BASE_MS = 250;
/** Backoff ceiling (ms) so a long outage does not produce multi-minute waits. */
const BACKOFF_CAP_MS = 10_000;

/** Default `setTimeout`-backed sleep. */
function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capped exponential backoff with full jitter for retry attempt `n` (1-based):
 * `random(0, min(cap, base * 2^(n-1)))`. Jitter spreads retries to avoid
 * thundering-herd reconnects; the result is still monotonic in expectation.
 */
function defaultDelayMs(attempt: number): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  // Full jitter keeps the upper bound growing while spreading load.
  return Math.random() * exp;
}

/**
 * Run `fn` with retry on transient failure.
 *
 * @typeParam T  The value `fn` resolves to.
 * @param fn      The operation to run (re-invoked on each retry).
 * @param policy  The retry policy.
 * @returns The first successful value.
 * @throws The last error once retries are exhausted or `retryOn` returns `false`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  const sleep = policy.sleep ?? defaultSleep;
  const delayMs = policy.delayMs ?? defaultDelayMs;
  const maxRetries = Math.max(0, policy.maxRetries);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const hasRetryBudget = attempt < maxRetries;
      if (!hasRetryBudget || !policy.retryOn(err)) {
        throw err;
      }
      const retryAfterSecs = policy.retryAfter?.(err);
      const waitMs =
        retryAfterSecs !== undefined && Number.isFinite(retryAfterSecs)
          ? Math.max(0, retryAfterSecs) * 1000
          : delayMs(attempt + 1);
      await sleep(waitMs);
    }
  }
  // Unreachable: the loop returns on success or throws on the final attempt.
  throw lastError;
}
