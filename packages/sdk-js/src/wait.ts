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
 *     The order may already be `OTP_RECEIVED` without a classified code; that is
 *     SMS delivery evidence, but this code-only helper keeps polling.
 *  3. If the order reached a TERMINAL status with no classified code → throw
 *     {@link OrderTerminalError}.
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
  sms_revision?: number | null;
}

/** Terminal order states — once reached, no new classified OTP will arrive. */
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
   * Resend code baseline. By itself, this ignores the same preserved code and
   * resolves on a different non-empty code. Pair it with `afterRevision` to also
   * detect identical-code or no-code follow-up SMS deliveries.
   */
  afterCode?: string;
  /**
   * Resend baseline for SMS delivery. When set, a retained `otp_code` becomes
   * usable once `sms_revision` advances beyond this value, even when the new SMS
   * has no classified code of its own. Pass the revision observed before
   * `resend`; inspect `result.order.otp_message` for the exact latest SMS.
   */
  afterRevision?: number;
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
 * @param opts     Timeout / interval / resend baselines / injectable clock.
 * A helper error is not proof that cancellation is allowed: an SMS without a
 * classified code closes refund eligibility. Fetch the current order and gate
 * cancellation on its server-authoritative `can_cancel` capability.
 *
 * @throws {OrderTerminalError} the order reached a terminal status with no classified code.
 * @throws {OtpTimeoutError}    `timeoutMs` elapsed with no classified code.
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
  const afterRevision = opts.afterRevision;

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

    // OTP arrived → done (even on a COMPLETED order that carries one). A resend
    // can retain the aggregate code while a new no-code SMS advances the durable
    // revision, so either a changed code or an advanced revision satisfies the
    // caller's baseline. Without a baseline, any non-empty code resolves.
    const code = order.otp_code;
    const hasCode = code != null && code !== "";
    const codeChanged = afterCode !== undefined && code !== afterCode;
    const revisionAdvanced =
      afterRevision !== undefined &&
      typeof order.sms_revision === "number" &&
      order.sms_revision > afterRevision;
    const hasBaseline = afterCode !== undefined || afterRevision !== undefined;
    if (hasCode && (!hasBaseline || codeChanged || revisionAdvanced)) {
      return { otpCode: code, status: order.status, order };
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
