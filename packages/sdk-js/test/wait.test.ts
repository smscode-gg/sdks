/**
 * Order mutations + `waitForOtp`.
 *
 * THE KEY PROPERTY: `waitForOtp` polls the **FX-FREE** `/v1/orders/{id}` path, so
 * a `/v2` FX `503 FX_RATE_UNAVAILABLE` can NEVER break OTP-waiting. The headline
 * test mocks `/v2/orders/{id}` → 503 but `/v1/orders/{id}` → an order with an OTP,
 * and asserts `waitForOtp` resolves via `/v1`.
 *
 * Plus the boundary behaviors: a terminal status without an OTP → `OrderTerminalError`;
 * no OTP before `timeoutMs` → `OtpTimeoutError`; a `429` mid-poll → back off using
 * `Retry-After`, then continue.
 *
 * Time is injected (a controllable `sleep`/`now`) so every test is deterministic
 * and instant — never a real wall-clock wait. The fetch mock drives the REAL client
 * path (URL build, headers, envelope parse, error mapping), not a mock of the client.
 */
import { describe, expect, it } from "vitest";

import { SmscodeClient } from "../src/client.js";
import {
  OrderTerminalError,
  OtpTimeoutError,
  type SmscodeError,
} from "../src/errors.js";

/** A recorded request, captured by a fake fetch. */
interface Captured {
  url: string;
  init: RequestInit;
}

/** One scripted response for a path-routed fetch. */
interface ScriptedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fake fetch routed by URL pathname. Each path maps to either a single response
 * (returned every time) or a queue of responses (consumed one per call, the last
 * repeating once drained). Records every call into `sink`.
 */
function routedFetch(
  routes: Record<string, ScriptedResponse | ScriptedResponse[]>,
  sink?: Captured[],
): typeof fetch {
  // Per-path call counters for queued responses.
  const counters: Record<string, number> = {};
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sink?.push({ url, init: init ?? {} });
    const pathname = new URL(url).pathname;
    const route = routes[pathname];
    if (route === undefined) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "NOT_FOUND", message: `no route for ${pathname}` },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    let chosen: ScriptedResponse;
    if (Array.isArray(route)) {
      const n = counters[pathname] ?? 0;
      counters[pathname] = n + 1;
      chosen = route[Math.min(n, route.length - 1)]!;
    } else {
      chosen = route;
    }
    const status = chosen.status ?? 200;
    const headers = new Headers({
      "Content-Type": "application/json",
      ...chosen.headers,
    });
    const text = chosen.body === undefined ? "" : JSON.stringify(chosen.body);
    return new Response(text, { status, headers });
  }) as typeof fetch;
}

/** A controllable injected clock: `now()` advances by exactly each slept `ms`. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** A `/v1` order-get success response (a 200 carrying the order envelope). */
function v1OrderEnvelope(order: Record<string, unknown>): ScriptedResponse {
  return { status: 200, body: { success: true, data: order } };
}

/** The standard `/v2` FX-unavailable failure envelope. */
const V2_FX_503: ScriptedResponse = {
  status: 503,
  body: {
    success: false,
    error: { code: "FX_RATE_UNAVAILABLE", message: "USD/IDR rate unavailable" },
  },
};

describe("waitForOtp — resolves via the FX-FREE /v1 path", () => {
  it("succeeds even when /v2/orders/{id} returns 503 FX_RATE_UNAVAILABLE", async () => {
    const calls: Captured[] = [];
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch(
        {
          // /v2 is BROKEN — FX rate cannot be sourced.
          "/v2/orders/90210": V2_FX_503,
          // /v1 is FX-FREE — first poll: no OTP yet; second poll: OTP arrived.
          "/v1/orders/90210": [
            v1OrderEnvelope({ id: 90210, status: "ACTIVE", otp_code: null }),
            v1OrderEnvelope({
              id: 90210,
              status: "OTP_RECEIVED",
              otp_code: "123456",
            }),
          ],
        },
        calls,
      ),
    });

    const result = await client.orders.waitForOtp(90210, {
      pollIntervalMs: 2000,
      timeoutMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
    });

    // Resolved via /v1, despite the /v2 503.
    expect(result.otpCode).toBe("123456");
    expect(result.status).toBe("OTP_RECEIVED");
    expect(result.order.id).toBe(90210);

    // PROOF it polled /v1, never /v2: every request hit the /v1 path.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(new URL(c.url).pathname).toBe("/v1/orders/90210");
    }
    // It did NOT touch the broken /v2 path even once.
    expect(
      calls.some((c) => new URL(c.url).pathname.startsWith("/v2")),
    ).toBe(false);
  });

  it("the /v1 namespace waitForOtp also polls /v1 and survives a /v2 503", async () => {
    const calls: Captured[] = [];
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch(
        {
          "/v2/orders/90210": V2_FX_503,
          "/v1/orders/90210": v1OrderEnvelope({
            id: 90210,
            status: "OTP_RECEIVED",
            otp_code: "654321",
          }),
        },
        calls,
      ),
    });

    const result = await client.v1.orders.waitForOtp(90210, {
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.otpCode).toBe("654321");
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/orders/90210");
  });
});

describe("waitForOtp — terminal status without an OTP", () => {
  for (const status of ["EXPIRED", "CANCELED"] as const) {
    it(`throws OrderTerminalError on a ${status} order with no OTP`, async () => {
      const clock = fakeClock();
      const client = new SmscodeClient({
        token: "t",
        fetch: routedFetch({
          "/v1/orders/90210": v1OrderEnvelope({
            id: 90210,
            status,
            otp_code: null,
          }),
        }),
      });

      const err = (await client.orders
        .waitForOtp(90210, { sleep: clock.sleep, now: clock.now })
        .catch((e: unknown) => e)) as OrderTerminalError;

      expect(err).toBeInstanceOf(OrderTerminalError);
      expect(err.code).toBe("ORDER_TERMINAL");
      expect(err.orderId).toBe(90210);
      expect(err.status).toBe(status);
    });
  }

  it("throws OrderTerminalError on a COMPLETED order with NO OTP", async () => {
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch({
        "/v1/orders/90210": v1OrderEnvelope({
          id: 90210,
          status: "COMPLETED",
          otp_code: null,
        }),
      }),
    });

    const err = (await client.orders
      .waitForOtp(90210, { sleep: clock.sleep, now: clock.now })
      .catch((e: unknown) => e)) as OrderTerminalError;

    expect(err).toBeInstanceOf(OrderTerminalError);
    expect(err.status).toBe("COMPLETED");
  });

  it("a COMPLETED order WITH an OTP resolves (does NOT throw)", async () => {
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch({
        "/v1/orders/90210": v1OrderEnvelope({
          id: 90210,
          status: "COMPLETED",
          otp_code: "999000",
        }),
      }),
    });

    const result = await client.orders.waitForOtp(90210, {
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.otpCode).toBe("999000");
    expect(result.status).toBe("COMPLETED");
  });
});

describe("waitForOtp — timeout", () => {
  it("keeps polling when an SMS arrived without a classified code", async () => {
    const calls: Captured[] = [];
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch(
        {
          "/v1/orders/90210": [
            v1OrderEnvelope({
              id: 90210,
              status: "OTP_RECEIVED",
              otp_code: null,
              otp_message: "Confirm via https://example.test/link",
              can_cancel: false,
            }),
            v1OrderEnvelope({
              id: 90210,
              status: "OTP_RECEIVED",
              otp_code: "123456",
              can_cancel: false,
            }),
          ],
        },
        calls,
      ),
    });

    const result = await client.orders.waitForOtp(90210, {
      pollIntervalMs: 2000,
      timeoutMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.otpCode).toBe("123456");
    expect(calls).toHaveLength(2);
  });

  it("throws OtpTimeoutError when no OTP arrives before timeoutMs", async () => {
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      // Always ACTIVE, OTP never arrives.
      fetch: routedFetch({
        "/v1/orders/90210": v1OrderEnvelope({
          id: 90210,
          status: "ACTIVE",
          otp_code: null,
        }),
      }),
    });

    const err = (await client.orders
      .waitForOtp(90210, {
        pollIntervalMs: 2000,
        timeoutMs: 10_000,
        sleep: clock.sleep,
        now: clock.now,
      })
      .catch((e: unknown) => e)) as OtpTimeoutError;

    expect(err).toBeInstanceOf(OtpTimeoutError);
    expect(err.code).toBe("OTP_TIMEOUT");
    expect(err.orderId).toBe(90210);
    expect(err.timeoutMs).toBe(10_000);
    // The injected clock never exceeded the budget by more than one interval.
    expect(clock.now()).toBeGreaterThanOrEqual(10_000);
  });

  it("times out on a delivered message-only SMS instead of treating it as a code", async () => {
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch({
        "/v1/orders/90210": v1OrderEnvelope({
          id: 90210,
          status: "OTP_RECEIVED",
          otp_code: null,
          otp_message: "Confirm via https://example.test/link",
          sms_revision: 1,
          can_finish: true,
          can_cancel: false,
        }),
      }),
    });

    const err = (await client.orders
      .waitForOtp(90210, {
        pollIntervalMs: 2000,
        timeoutMs: 4000,
        sleep: clock.sleep,
        now: clock.now,
      })
      .catch((error: unknown) => error)) as OtpTimeoutError;

    expect(err).toBeInstanceOf(OtpTimeoutError);
    expect(err.orderId).toBe(90210);
  });
});

describe("waitForOtp — 429 mid-poll backs off using Retry-After", () => {
  it("sleeps retryAfterSeconds on a 429, then continues polling to success", async () => {
    const calls: Captured[] = [];
    const sleeps: number[] = [];
    let t = 0;
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    };
    const now = () => t;
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch(
        {
          "/v1/orders/90210": [
            // First poll → 429 with Retry-After: 5s.
            {
              status: 429,
              body: {
                success: false,
                error: {
                  code: "RATE_LIMIT_EXCEEDED",
                  message: "slow down",
                },
              },
              headers: { "Retry-After": "5" },
            },
            // Second poll → OTP present.
            v1OrderEnvelope({
              id: 90210,
              status: "OTP_RECEIVED",
              otp_code: "246810",
            }),
          ],
        },
        calls,
      ),
    });

    const result = await client.orders.waitForOtp(90210, {
      pollIntervalMs: 2000,
      timeoutMs: 60_000,
      sleep,
      now,
    });

    expect(result.otpCode).toBe("246810");
    // The 429 caused a 5s (Retry-After) back-off — distinct from the 2s poll cadence.
    expect(sleeps).toContain(5000);
    // Two polls total (429, then success).
    expect(calls).toHaveLength(2);
  });

  it("falls back to pollIntervalMs on a 429 with no Retry-After", async () => {
    const sleeps: number[] = [];
    let t = 0;
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch({
        "/v1/orders/90210": [
          {
            status: 429,
            body: {
              success: false,
              error: { code: "RATE_LIMIT_EXCEEDED", message: "slow down" },
            },
          },
          v1OrderEnvelope({
            id: 90210,
            status: "OTP_RECEIVED",
            otp_code: "112233",
          }),
        ],
      }),
    });

    const result = await client.orders.waitForOtp(90210, {
      pollIntervalMs: 3000,
      timeoutMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
    });

    expect(result.otpCode).toBe("112233");
    // No Retry-After → the poll interval is used for the wait.
    expect(sleeps).toContain(3000);
  });
});

describe("waitForOtp — a non-transient error propagates (not swallowed)", () => {
  it("rethrows a 401 from the /v1 poll", async () => {
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch({
        "/v1/orders/90210": {
          status: 401,
          body: {
            success: false,
            error: { code: "UNAUTHORIZED", message: "bad token" },
          },
        },
      }),
    });

    const err = (await client.orders
      .waitForOtp(90210, { sleep: clock.sleep, now: clock.now })
      .catch((e: unknown) => e)) as SmscodeError;

    expect(err.code).toBe("UNAUTHORIZED");
  });
});

describe("waitForOtp — afterCode baseline (ignore the stale code after a resend)", () => {
  it("resolves when sms_revision advances even if a no-code follow-up retains afterCode", async () => {
    const calls: Captured[] = [];
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch(
        {
          "/v1/orders/90210": [
            v1OrderEnvelope({
              id: 90210,
              status: "OTP_RECEIVED",
              otp_code: "111111",
              otp_message: "Your code is 111111",
              sms_revision: 7,
            }),
            v1OrderEnvelope({
              id: 90210,
              status: "OTP_RECEIVED",
              otp_code: "111111",
              otp_message: "Confirm at https://example.test/confirm",
              sms_revision: 8,
            }),
          ],
        },
        calls,
      ),
    });

    const result = await client.orders.waitForOtp(90210, {
      afterCode: "111111",
      afterRevision: 7,
      pollIntervalMs: 2000,
      timeoutMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.otpCode).toBe("111111");
    expect(result.order.otp_message).toBe("Confirm at https://example.test/confirm");
    expect(result.order.sms_revision).toBe(8);
    expect(calls).toHaveLength(2);
  });

  it("ignores the preserved stale code === afterCode, resolves on a changed code", async () => {
    const calls: Captured[] = [];
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch(
        {
          "/v1/orders/90210": [
            // After a resend the OLD code is preserved — must NOT resolve on it.
            v1OrderEnvelope({ id: 90210, status: "ACTIVE", otp_code: "111111" }),
            // The genuinely new code — resolves.
            v1OrderEnvelope({ id: 90210, status: "OTP_RECEIVED", otp_code: "222222" }),
          ],
        },
        calls,
      ),
    });

    const result = await client.orders.waitForOtp(90210, {
      afterCode: "111111",
      pollIntervalMs: 2000,
      timeoutMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.otpCode).toBe("222222");
    expect(calls).toHaveLength(2); // first poll's stale code was skipped, not returned
  });

  it("resolves immediately on a code !== afterCode (first poll)", async () => {
    const calls: Captured[] = [];
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch(
        {
          "/v1/orders/90210": v1OrderEnvelope({
            id: 90210,
            status: "OTP_RECEIVED",
            otp_code: "222222",
          }),
        },
        calls,
      ),
    });

    const result = await client.orders.waitForOtp(90210, {
      afterCode: "111111",
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.otpCode).toBe("222222");
    expect(calls).toHaveLength(1);
  });

  it("throws OrderTerminalError when the order goes terminal carrying only the stale afterCode", async () => {
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch({
        "/v1/orders/90210": v1OrderEnvelope({
          id: 90210,
          status: "COMPLETED",
          otp_code: "111111",
        }),
      }),
    });

    const err = (await client.orders
      .waitForOtp(90210, { afterCode: "111111", sleep: clock.sleep, now: clock.now })
      .catch((e: unknown) => e)) as OrderTerminalError;

    expect(err).toBeInstanceOf(OrderTerminalError);
    expect(err.status).toBe("COMPLETED");
  });

  it("times out when only the stale afterCode is ever present (non-terminal)", async () => {
    const clock = fakeClock();
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch({
        "/v1/orders/90210": v1OrderEnvelope({
          id: 90210,
          status: "ACTIVE",
          otp_code: "111111",
        }),
      }),
    });

    const err = (await client.orders
      .waitForOtp(90210, {
        afterCode: "111111",
        pollIntervalMs: 2000,
        timeoutMs: 10_000,
        sleep: clock.sleep,
        now: clock.now,
      })
      .catch((e: unknown) => e)) as OtpTimeoutError;

    expect(err).toBeInstanceOf(OtpTimeoutError);
    expect(err.timeoutMs).toBe(10_000);
  });

  it("still honors a 429 Retry-After, then resolves on a changed code (afterCode + rate-limit)", async () => {
    const sleeps: number[] = [];
    let t = 0;
    const client = new SmscodeClient({
      token: "t",
      fetch: routedFetch({
        "/v1/orders/90210": [
          {
            status: 429,
            body: {
              success: false,
              error: { code: "RATE_LIMIT_EXCEEDED", message: "slow down" },
            },
            headers: { "Retry-After": "5" },
          },
          v1OrderEnvelope({ id: 90210, status: "ACTIVE", otp_code: "111111" }), // stale — skipped
          v1OrderEnvelope({ id: 90210, status: "OTP_RECEIVED", otp_code: "333333" }), // new
        ],
      }),
    });

    const result = await client.orders.waitForOtp(90210, {
      afterCode: "111111",
      pollIntervalMs: 2000,
      timeoutMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
    });

    expect(result.otpCode).toBe("333333");
    expect(sleeps).toContain(5000); // Retry-After honored
  });
});
