/**
 * Typed error model for the SMSCode SDK.
 *
 * Every API failure surfaces as an {@link SmscodeError} (or a transport
 * subclass). Business failures carry a stable {@link ErrorCode}; branch on
 * `err.code` (or `instanceof` the typed subclass), never on `err.message`.
 *
 * @see {@link mapError} — turns an HTTP status + parsed envelope into the right
 * subclass.
 */
import type { components } from "./types.gen.js";

/**
 * Stable, machine-readable error identifier (re-exported from the generated
 * OpenAPI types so the SDK and the contract never drift).
 */
export type ErrorCode = components["schemas"]["ErrorCode"];

/**
 * An order lifecycle status (re-exported from the generated OpenAPI types).
 * Used by the SDK-side {@link OrderTerminalError}.
 */
export type OrderStatus = components["schemas"]["OrderStatusEnum"];

/** The structured error payload carried inside a failure envelope. */
export interface ApiErrorObject {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** The failure envelope shape (`success: false`). */
export interface ApiErrorResponse {
  success: false;
  error: ApiErrorObject;
}

/** Options accepted by the {@link SmscodeError} constructor. */
export interface SmscodeErrorOptions {
  httpStatus?: number;
  details?: Record<string, unknown>;
  requestId?: string;
  retryAfterSeconds?: number;
  idempotencyKey?: string;
  cause?: unknown;
}

/**
 * Base class for every error thrown by the SDK.
 *
 * `code` is the API's stable {@link ErrorCode} for a business failure, or a
 * synthetic identifier for transport-layer failures (e.g. `NETWORK_ERROR`).
 */
export class SmscodeError extends Error {
  /** Stable error identifier — branch on this, not on `message`. */
  readonly code: string;
  /** HTTP status that accompanied the error, when one was received. */
  readonly httpStatus?: number;
  /** Optional structured context (validation fields, ban metadata, …). */
  readonly details?: Record<string, unknown>;
  /** The `X-Request-Id` of the originating response, for support/debugging. */
  readonly requestId?: string;
  /** Seconds to wait before retrying (from `Retry-After` or `details`). */
  readonly retryAfterSeconds?: number;
  /** The idempotency key associated with the request, when known. */
  readonly idempotencyKey?: string;

  constructor(code: string, message: string, options: SmscodeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.details !== undefined) this.details = options.details;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.idempotencyKey !== undefined)
      this.idempotencyKey = options.idempotencyKey;
    // Keep the prototype chain correct when compiled down to ES targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Stamp the idempotency key of the originating write onto this error, once.
   *
   * Used by `orders.create` so that **every** error thrown from a create (typed
   * API errors, transport errors, and the final retry-exhaustion throw) carries
   * the SAME resolved key — the caller can always retry with it. This is the
   * sanctioned writer for the otherwise-`readonly` {@link idempotencyKey}; it is
   * write-once (the first key wins, so a re-thrown error is never relabeled).
   *
   * @returns `this`, for fluent use in a `catch`.
   * @internal
   */
  withIdempotencyKey(key: string): this {
    if (this.idempotencyKey === undefined) {
      // `readonly` is a compile-time contract for consumers; the owning class may
      // initialize the field after construction. Cast through the writable view.
      (this as { idempotencyKey?: string }).idempotencyKey = key;
    }
    return this;
  }
}

/**
 * A business error with a fixed {@link ErrorCode}. Subclasses bind `code` so
 * the constructor signature is just `(message, options)`.
 */
abstract class CodedError extends SmscodeError {
  constructor(
    code: ErrorCode,
    message: string,
    options: SmscodeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** `401 UNAUTHORIZED` — authentication missing or invalid. */
export class UnauthorizedError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("UNAUTHORIZED", message, options);
  }
}

/** `403 FORBIDDEN` — authenticated but not permitted. */
export class ForbiddenError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("FORBIDDEN", message, options);
  }
}

/** `404 NOT_FOUND` — the resource does not exist. */
export class NotFoundError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("NOT_FOUND", message, options);
  }
}

/** `422 VALIDATION_ERROR` — request failed schema/business validation. */
export class ValidationError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("VALIDATION_ERROR", message, options);
  }
}

/** `422 PROVIDER_ERROR` — an upstream SMS provider failed. */
export class ProviderError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("PROVIDER_ERROR", message, options);
  }
}

/** `422 NO_OFFER_AVAILABLE` — no purchasable offer for the catalog product. */
export class NoOfferAvailableError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("NO_OFFER_AVAILABLE", message, options);
  }
}

/** `422 IDEMPOTENCY_KEY_REUSED` — key reused with a different payload. */
export class IdempotencyKeyReuseError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("IDEMPOTENCY_KEY_REUSED", message, options);
  }
}

/** `409 INSUFFICIENT_BALANCE` — not enough balance for the operation. */
export class InsufficientBalanceError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("INSUFFICIENT_BALANCE", message, options);
  }
}

/** `409 CONFLICT` — the request conflicts with current resource state. */
export class ConflictError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("CONFLICT", message, options);
  }
}

/** `409 CANCEL_TOO_EARLY` — order cannot be cancelled yet. */
export class CancelTooEarlyError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("CANCEL_TOO_EARLY", message, options);
  }
}

/** `409 REQUEST_IN_PROGRESS` — a concurrent request for the same key is running. */
export class RequestInProgressError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("REQUEST_IN_PROGRESS", message, options);
  }
}

/** `429 RATE_LIMIT_EXCEEDED` — ordinary throttling. Honor `retryAfterSeconds`. */
export class RateLimitError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("RATE_LIMIT_EXCEEDED", message, options);
  }
}

/**
 * `429 TEMP_BANNED_ABUSE_GUARD` — an abuse tripwire tripped.
 *
 * Exposes the ban metadata from `details.{until, tier, retry_after_seconds}`.
 */
export class TempBannedError extends CodedError {
  /** RFC 3339 timestamp at which the ban lifts, when provided. */
  readonly until?: string;
  /** Escalating ban tier, when provided. */
  readonly tier?: number;

  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("TEMP_BANNED_ABUSE_GUARD", message, options);
    const details = options.details ?? {};
    if (typeof details.until === "string") this.until = details.until;
    if (typeof details.tier === "number") this.tier = details.tier;
  }
}

/** `503 SERVICE_UNAVAILABLE` — temporary outage. A `Retry-After` may be set. */
export class ServiceUnavailableError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("SERVICE_UNAVAILABLE", message, options);
  }
}

/** `503 FX_RATE_UNAVAILABLE` — USD/IDR rate could not be sourced for a `/v2` projection. */
export class FxRateUnavailableError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("FX_RATE_UNAVAILABLE", message, options);
  }
}

/** `500 INTERNAL_ERROR` — an unexpected server-side failure. */
export class InternalError extends CodedError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("INTERNAL_ERROR", message, options);
  }
}

/**
 * `413 Payload Too Large` — the request body exceeded the server limit.
 *
 * This status has no `error.code` in the contract (the body may not be JSON),
 * so it is its own class, resolved purely by HTTP status.
 */
export class PayloadTooLargeError extends SmscodeError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("PAYLOAD_TOO_LARGE", message, options);
  }
}

/** A `fetch` rejection — DNS failure, connection reset, CORS, etc. */
export class NetworkError extends SmscodeError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("NETWORK_ERROR", message, options);
  }
}

/**
 * `ORDER_TERMINAL` — `waitForOtp` stopped because the order reached a terminal
 * state (`EXPIRED` / `CANCELED` / `COMPLETED`) **without** an OTP ever arriving.
 *
 * This is an **SDK-side** code (not an API {@link ErrorCode}): it is synthesized by
 * the polling loop, never returned by the server. Branch on `err.status` to learn
 * which terminal state was reached.
 */
export class OrderTerminalError extends SmscodeError {
  /** The order being waited on. */
  readonly orderId: number;
  /** The terminal order status that ended the wait. */
  readonly status: OrderStatus;

  constructor(
    orderId: number,
    status: OrderStatus,
    options: SmscodeErrorOptions = {},
  ) {
    super(
      "ORDER_TERMINAL",
      `Order ${orderId} reached terminal status ${status} without an OTP.`,
      options,
    );
    this.orderId = orderId;
    this.status = status;
  }
}

/**
 * `OTP_TIMEOUT` — `waitForOtp` gave up because `timeoutMs` elapsed before an OTP
 * arrived (the order was still pending).
 *
 * This is an **SDK-side** code (not an API {@link ErrorCode}): it is synthesized by
 * the polling loop, never returned by the server.
 */
export class OtpTimeoutError extends SmscodeError {
  /** The order being waited on. */
  readonly orderId: number;
  /** The elapsed budget (ms) after which the wait was abandoned. */
  readonly timeoutMs: number;

  constructor(
    orderId: number,
    timeoutMs: number,
    options: SmscodeErrorOptions = {},
  ) {
    super(
      "OTP_TIMEOUT",
      `Timed out after ${timeoutMs}ms waiting for an OTP on order ${orderId}.`,
      options,
    );
    this.orderId = orderId;
    this.timeoutMs = timeoutMs;
  }
}

/** The request exceeded the configured `timeoutMs` and was aborted. */
export class TimeoutError extends SmscodeError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("TIMEOUT", message, options);
  }
}

/** The request was aborted by the caller (a non-timeout abort). */
export class AbortError extends SmscodeError {
  constructor(message: string, options: SmscodeErrorOptions = {}) {
    super("ABORTED", message, options);
  }
}

/** Maps an {@link ErrorCode} to its concrete error class. */
const CODE_TO_CTOR: Record<
  ErrorCode,
  new (message: string, options?: SmscodeErrorOptions) => SmscodeError
> = {
  UNAUTHORIZED: UnauthorizedError,
  FORBIDDEN: ForbiddenError,
  NOT_FOUND: NotFoundError,
  VALIDATION_ERROR: ValidationError,
  PROVIDER_ERROR: ProviderError,
  NO_OFFER_AVAILABLE: NoOfferAvailableError,
  IDEMPOTENCY_KEY_REUSED: IdempotencyKeyReuseError,
  INSUFFICIENT_BALANCE: InsufficientBalanceError,
  CONFLICT: ConflictError,
  CANCEL_TOO_EARLY: CancelTooEarlyError,
  REQUEST_IN_PROGRESS: RequestInProgressError,
  RATE_LIMIT_EXCEEDED: RateLimitError,
  TEMP_BANNED_ABUSE_GUARD: TempBannedError,
  SERVICE_UNAVAILABLE: ServiceUnavailableError,
  FX_RATE_UNAVAILABLE: FxRateUnavailableError,
  INTERNAL_ERROR: InternalError,
};

/**
 * Best-effort fallback class when the body carries no recognizable `error.code`.
 * Returns `undefined` for statuses with no specific subclass — the caller then
 * constructs a base {@link SmscodeError}.
 */
function ctorForStatus(
  status: number,
): (new (message: string, options?: SmscodeErrorOptions) => SmscodeError) | undefined {
  switch (status) {
    case 401:
      return UnauthorizedError;
    case 403:
      return ForbiddenError;
    case 404:
      return NotFoundError;
    case 413:
      return PayloadTooLargeError;
    case 422:
      return ValidationError;
    case 429:
      return RateLimitError;
    case 503:
      return ServiceUnavailableError;
    case 500:
      return InternalError;
    default:
      return undefined;
  }
}

/** Synthetic `code` for a base error mapped purely from its HTTP status. */
function syntheticCodeForStatus(status: number): string {
  return `HTTP_${status}`;
}

/** Parse a `Retry-After` header value (delta-seconds form) into a number. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Pull `retry_after_seconds` out of a `details` object, if numeric. */
function retryAfterFromDetails(
  details: Record<string, unknown> | undefined,
): number | undefined {
  const raw = details?.retry_after_seconds;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Turn an HTTP status + parsed response body into the right {@link SmscodeError}.
 *
 * - If `body.error.code` is a recognized {@link ErrorCode} → the matching subclass.
 * - Otherwise → the subclass for the HTTP status (falling back to the base class).
 * - `retryAfterSeconds` comes from the `Retry-After` header first, then
 *   `details.retry_after_seconds`.
 *
 * @param httpStatus  HTTP status of the response.
 * @param body        Parsed JSON body, or `undefined` when it was not JSON.
 * @param requestId   The captured `X-Request-Id`, if any.
 * @param headers     Response headers (for `Retry-After`), if available.
 */
export function mapError(
  httpStatus: number,
  body: unknown,
  requestId?: string,
  headers?: Headers,
): SmscodeError {
  const envelope =
    body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const errObj =
    envelope && typeof envelope.error === "object" && envelope.error !== null
      ? (envelope.error as Record<string, unknown>)
      : undefined;

  const code =
    errObj && typeof errObj.code === "string"
      ? (errObj.code as string)
      : undefined;
  const message =
    (errObj && typeof errObj.message === "string"
      ? (errObj.message as string)
      : undefined) ?? `HTTP ${httpStatus}`;
  const details =
    errObj && typeof errObj.details === "object" && errObj.details !== null
      ? (errObj.details as Record<string, unknown>)
      : undefined;

  const retryAfterSeconds =
    parseRetryAfter(headers?.get("Retry-After")) ??
    retryAfterFromDetails(details);

  const options: SmscodeErrorOptions = { httpStatus };
  if (requestId !== undefined) options.requestId = requestId;
  if (details !== undefined) options.details = details;
  if (retryAfterSeconds !== undefined)
    options.retryAfterSeconds = retryAfterSeconds;

  if (code && code in CODE_TO_CTOR) {
    return new CODE_TO_CTOR[code as ErrorCode](message, options);
  }

  const Ctor = ctorForStatus(httpStatus);
  if (Ctor) {
    return new Ctor(message, options);
  }

  // No recognized code and no status-specific subclass → base error.
  return new SmscodeError(syntheticCodeForStatus(httpStatus), message, options);
}
