import { describe, expect, it } from "vitest";

import {
  AbortError,
  ConflictError,
  CancelTooEarlyError,
  ForbiddenError,
  FxRateUnavailableError,
  IdempotencyKeyReuseError,
  InsufficientBalanceError,
  InternalError,
  NetworkError,
  NoOfferAvailableError,
  NotFoundError,
  PayloadTooLargeError,
  ProviderError,
  RateLimitError,
  RequestInProgressError,
  ServiceUnavailableError,
  SmscodeError,
  TempBannedError,
  TimeoutError,
  UnauthorizedError,
  ValidationError,
  mapError,
} from "../src/errors.js";
import type { ErrorCode } from "../src/errors.js";

/** Build a minimal failure envelope for a given error code. */
function envelope(
  code: ErrorCode,
  extra?: { message?: string; details?: Record<string, unknown> },
) {
  return {
    success: false as const,
    error: {
      code,
      message: extra?.message ?? `error: ${code}`,
      ...(extra?.details ? { details: extra.details } : {}),
    },
  };
}

describe("mapError — code → subclass (table-driven over the 16 codes)", () => {
  const cases: Array<{
    code: ErrorCode;
    status: number;
    ctor: new (...args: never[]) => SmscodeError;
  }> = [
    { code: "UNAUTHORIZED", status: 401, ctor: UnauthorizedError },
    { code: "FORBIDDEN", status: 403, ctor: ForbiddenError },
    { code: "NOT_FOUND", status: 404, ctor: NotFoundError },
    { code: "VALIDATION_ERROR", status: 422, ctor: ValidationError },
    // Statuses below mirror the real API (vn-api `error.rs`): PROVIDER_ERROR,
    // NO_OFFER_AVAILABLE, IDEMPOTENCY_KEY_REUSED → 422; INSUFFICIENT_BALANCE → 409.
    { code: "PROVIDER_ERROR", status: 422, ctor: ProviderError },
    { code: "NO_OFFER_AVAILABLE", status: 422, ctor: NoOfferAvailableError },
    {
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 422,
      ctor: IdempotencyKeyReuseError,
    },
    {
      code: "INSUFFICIENT_BALANCE",
      status: 409,
      ctor: InsufficientBalanceError,
    },
    { code: "CONFLICT", status: 409, ctor: ConflictError },
    { code: "CANCEL_TOO_EARLY", status: 409, ctor: CancelTooEarlyError },
    {
      code: "REQUEST_IN_PROGRESS",
      status: 409,
      ctor: RequestInProgressError,
    },
    { code: "RATE_LIMIT_EXCEEDED", status: 429, ctor: RateLimitError },
    { code: "TEMP_BANNED_ABUSE_GUARD", status: 429, ctor: TempBannedError },
    {
      code: "SERVICE_UNAVAILABLE",
      status: 503,
      ctor: ServiceUnavailableError,
    },
    { code: "FX_RATE_UNAVAILABLE", status: 503, ctor: FxRateUnavailableError },
    { code: "INTERNAL_ERROR", status: 500, ctor: InternalError },
  ];

  it("maps all 16 codes (no gaps)", () => {
    expect(cases).toHaveLength(16);
  });

  for (const { code, status, ctor } of cases) {
    it(`maps ${code} → ${ctor.name}`, () => {
      const err = mapError(status, envelope(code), "req-1");
      expect(err).toBeInstanceOf(ctor);
      expect(err).toBeInstanceOf(SmscodeError);
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(status);
      expect(err.requestId).toBe("req-1");
      expect(err.message).toBe(`error: ${code}`);
    });
  }
});

describe("mapError — Retry-After + details", () => {
  it("pulls retryAfterSeconds from the Retry-After header for 429 RATE_LIMIT", () => {
    const headers = new Headers({ "Retry-After": "30" });
    const err = mapError(429, envelope("RATE_LIMIT_EXCEEDED"), "req-2", headers);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("falls back to details.retry_after_seconds when no header is present", () => {
    const err = mapError(
      429,
      envelope("RATE_LIMIT_EXCEEDED", {
        details: { retry_after_seconds: 12 },
      }),
      "req-3",
    );
    expect(err.retryAfterSeconds).toBe(12);
  });

  it("TempBannedError reads details.{until, tier, retry_after_seconds}", () => {
    const err = mapError(
      429,
      envelope("TEMP_BANNED_ABUSE_GUARD", {
        details: {
          until: "2026-07-01T00:00:00Z",
          tier: 2,
          retry_after_seconds: 3600,
        },
      }),
      "req-4",
    );
    expect(err).toBeInstanceOf(TempBannedError);
    const banned = err as TempBannedError;
    expect(banned.until).toBe("2026-07-01T00:00:00Z");
    expect(banned.tier).toBe(2);
    expect(banned.retryAfterSeconds).toBe(3600);
  });

  it("header wins over details for retryAfterSeconds", () => {
    const headers = new Headers({ "Retry-After": "5" });
    const err = mapError(
      429,
      envelope("RATE_LIMIT_EXCEEDED", { details: { retry_after_seconds: 99 } }),
      "req-5",
      headers,
    );
    expect(err.retryAfterSeconds).toBe(5);
  });
});

describe("mapError — fallback by HTTP status (no error.code)", () => {
  it("413 non-JSON body → PayloadTooLargeError", () => {
    const err = mapError(413, undefined, "req-6");
    expect(err).toBeInstanceOf(PayloadTooLargeError);
    expect(err.httpStatus).toBe(413);
  });

  it("body without error.code → base SmscodeError mapped by status (401)", () => {
    const err = mapError(401, { success: false }, "req-7");
    // 401 with no recognizable code still resolves to the UnauthorizedError subclass by status.
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.httpStatus).toBe(401);
  });

  it("unknown status with no code → base SmscodeError", () => {
    const err = mapError(418, undefined, "req-8");
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err.constructor).toBe(SmscodeError);
    expect(err.httpStatus).toBe(418);
  });

  it("captures details on the typed error", () => {
    const err = mapError(
      422,
      envelope("VALIDATION_ERROR", { details: { field: "email" } }),
      "req-9",
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual({ field: "email" });
  });
});

describe("transport errors", () => {
  it("NetworkError, TimeoutError, AbortError are SmscodeError subclasses", () => {
    expect(new NetworkError("boom")).toBeInstanceOf(SmscodeError);
    expect(new TimeoutError("slow")).toBeInstanceOf(SmscodeError);
    expect(new AbortError("stopped")).toBeInstanceOf(SmscodeError);
  });

  it("carry their name and message", () => {
    const net = new NetworkError("fetch failed");
    expect(net.name).toBe("NetworkError");
    expect(net.message).toBe("fetch failed");
  });
});
