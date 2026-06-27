/**
 * `waitForOtp` — poll an order until its verification code arrives.
 *
 * **FX-FREE by construction.** The poll always hits the canonical `/v1/orders/{id}`
 * path (a money-free status read with no FX projection), so a `/v2` FX outage
 * (`503 FX_RATE_UNAVAILABLE`) can NEVER break OTP-waiting. Both `client.orders` and
 * `client.v1.orders` expose `waitForOtp`, and both delegate here with the SAME `/v1`
 * poll — there is exactly one place that owns "is the OTP here yet?".
 *
 * The loop:
 *  1. Poll `/v1/orders/{id}`.
 *  2. If `otp_code` is non-null → resolve `{ otpCode, status, order }`.
 *  3. If the order reached a TERMINAL status with no OTP → throw {@link OrderTerminalError}.
 *  4. If the elapsed time would exceed `timeoutMs` → throw {@link OtpTimeoutError}.
 *  5. On a `429` (rate limit) → sleep `retryAfterSeconds` (falling back to the poll
 *     interval), then poll again. Any other error propagates.
 *
 * Both the wait clock (`sleep`) and the time source (`now`) are injectable so tests
 * stay instant and deterministic (no real wall-clock wait).
 */
import { OrderTerminalError, OtpTimeoutError, RateLimitError } from "./errors.js";
import type { OrderStatus } from "./errors.js";

/** The minimal order shape `waitForOtp` reads from the `/v1` status poll. */
export interface OtpPollSnapshot {
  status: OrderStatus;
  otp_code?: string | null;
}

/** Terminal order states — once reached, no OTP will ever arrive. */
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "COMPLETED",
  "CANCELED",
  "EXPIRED",
]);

/** Default cadence between polls (ms). */
const DEFAULT_POLL_INTERVAL_MS = 3000;
/**
 * Default overall budget (ms). 20 minutes comfortably covers a typical rental
 * window; callers with a known `expires_at` can pass a tighter `timeoutMs`.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** Options for {@link waitForOtp}. */
export interface WaitForOtpOptions {
  /** Overall budget in ms before {@link OtpTimeoutError}. Default 20 min. */
  timeoutMs?: number;
  /** Delay between polls in ms. Default 3000. */
  pollIntervalMs?: number;
  /**
   * Resend baseline: when set, `waitForOtp` IGNORES a polled `otp_code` equal to
   * this value and resolves only on a DIFFERENT non-empty code. Pass the code you
   * already received *before* a `resend` so the wait does not immediately
   * re-resolve on the preserved (non-cleared) prior code. **Limitation:** if the
   * platform genuinely re-sends an OTP with identical digits, this code-based
   * baseline cannot distinguish it — this is an observability/UX convenience, NOT
   * a money or lifecycle guarantee (`finish` still succeeds on any OTP evidence
   * after a resend, regardless of this option).
   */
  afterCode?: string;
  /** Wait clock. Defaults to a `setTimeout`-backed sleep. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic time source in ms. Defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
}

/** The successful result of {@link waitForOtp}. */
export interface OtpResult<TOrder extends OtpPollSnapshot> {
  /** The received verification code (guaranteed non-null on resolve). */
  otpCode: string;
  /** The order status at the moment the OTP was observed. */
  status: OrderStatus;
  /** The full polled order snapshot. */
  order: TOrder;
}

/** Default `setTimeout`-backed sleep. */
function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `poll(orderId)` until an OTP arrives.
 *
 * @typeParam TOrder  The polled order snapshot type (must expose `status` + `otp_code`).
 * @param poll     Fetches the current order snapshot. **Must hit the FX-free `/v1`
 *                 path** so an FX outage cannot break the wait.
 * @param orderId  The order to wait on.
 * @param opts     Timeout / interval / injectable clock.
 * @throws {OrderTerminalError} the order reached a terminal status with no OTP.
 * @throws {OtpTimeoutError}    `timeoutMs` elapsed with no OTP.
 * @throws Any non-`429` error from `poll` propagates unchanged.
 */
export async function waitForOtp<TOrder extends OtpPollSnapshot>(
  poll: (orderId: number) => Promise<TOrder>,
  orderId: number,
  opts: WaitForOtpOptions = {},
): Promise<OtpResult<TOrder>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const afterCode = opts.afterCode;

  const deadline = now() + timeoutMs;

  for (;;) {
    let order: TOrder;
    try {
      order = await poll(orderId);
    } catch (err) {
      // A rate limit is transient: honor Retry-After (else the poll interval) and
      // continue, as long as the budget allows. Every other error propagates.
      if (err instanceof RateLimitError) {
        const retryAfterMs =
          err.retryAfterSeconds !== undefined &&
          Number.isFinite(err.retryAfterSeconds)
            ? Math.max(0, err.retryAfterSeconds) * 1000
            : pollIntervalMs;
        if (now() + retryAfterMs > deadline) {
          throw new OtpTimeoutError(orderId, timeoutMs, { cause: err });
        }
        await sleep(retryAfterMs);
        continue;
      }
      throw err;
    }

    // OTP arrived → done (even on a COMPLETED order that carries one). With
    // `afterCode` set, a polled code EQUAL to the baseline is the stale pre-resend
    // code (resend never clears it) → skip it and keep polling for a new one.
    if (
      order.otp_code != null &&
      order.otp_code !== "" &&
      order.otp_code !== afterCode
    ) {
      return { otpCode: order.otp_code, status: order.status, order };
    }

    // Terminal status without an OTP → it will never arrive.
    if (TERMINAL_STATUSES.has(order.status)) {
      throw new OrderTerminalError(orderId, order.status);
    }

    // Not yet — wait for the next poll, unless the budget is spent.
    if (now() + pollIntervalMs > deadline) {
      throw new OtpTimeoutError(orderId, timeoutMs);
    }
    await sleep(pollIntervalMs);
  }
}
