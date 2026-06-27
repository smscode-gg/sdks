/**
 * Order mutations — `cancel` / `finish` / `resend`.
 *
 * These are single-order state changes. Per the contract they carry NO
 * idempotency key, so a blind auto-retry could double-apply a side effect — the
 * SDK therefore issues them with retry DISABLED (a network/429/503 surfaces as a
 * thrown error rather than being silently replayed).
 *
 * The body identifies the order as `{ id }` (the contract's `V1OrderIdRequest`,
 * shared by both `/v1` and `/v2`). `/v2` cancel decodes the two money fields to
 * USD {@link Money} objects and carries the FX receipt; `finish`/`resend` are
 * money-free on both surfaces. Tests drive the REAL client path via an injected
 * fetch mock.
 */
import { describe, expect, it } from "vitest";

import { SmscodeClient } from "../src/client.js";
import { SmscodeError } from "../src/errors.js";

/** A recorded request, captured by a fake fetch. */
interface Captured {
  url: string;
  init: RequestInit;
}

/** Build a fake fetch returning a fixed JSON response, recording every call. */
function fakeFetch(
  response: { status?: number; body?: unknown; headers?: Record<string, string> },
  sink?: Captured[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    sink?.push({ url: String(input), init: init ?? {} });
    const status = response.status ?? 200;
    const headers = new Headers({
      "Content-Type": "application/json",
      ...response.headers,
    });
    const text = response.body === undefined ? "" : JSON.stringify(response.body);
    return new Response(text, { status, headers });
  }) as typeof fetch;
}

/** Read the body JSON off a captured request. */
function bodyOf(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const V1_CANCEL_OK = {
  success: true,
  data: {
    order_id: 90210,
    status: "CANCELED",
    refund_amount: 750000,
    new_balance: 2000000,
  },
};

const V2_CANCEL_OK = {
  success: true,
  data: {
    order_id: 90210,
    status: "CANCELED",
    refund_amount: {
      amount: "0.5000",
      currency: "USD",
      canonical_amount: 750000,
      canonical_currency: "IDR",
    },
    new_balance: {
      amount: "1.25",
      currency: "USD",
      canonical_amount: 2000000,
      canonical_currency: "IDR",
    },
  },
  meta: { fx: { pair: "USD/IDR", rate: 1600000, rate_as_of: null } },
};

const FINISH_OK = {
  success: true,
  data: { order_id: 90210, status: "COMPLETED" },
};

const RESEND_OK = {
  success: true,
  data: { order_id: 90210, status: "ACTIVE", resent: true },
};

describe("orders.{cancel,finish,resend} — /v2 default surface", () => {
  it("cancel POSTs /v2/orders/cancel with { id } and decodes money + fx", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_CANCEL_OK }, calls),
    });

    const result = await client.orders.cancel(90210);

    expect(new URL(calls[0]!.url).pathname).toBe("/v2/orders/cancel");
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf(calls[0]!)).toEqual({ id: 90210 });
    expect(result.order_id).toBe(90210);
    expect(result.status).toBe("CANCELED");
    expect(result.refund_amount).toEqual({
      amount: "0.5000",
      currency: "USD",
      canonicalAmount: 750000,
      canonicalAmountRaw: "750000",
      canonicalCurrency: "IDR",
    });
    expect(result.new_balance.canonicalAmount).toBe(2000000);
    expect(result.fx).toEqual({ pair: "USD/IDR", rate: 1600000, rate_as_of: null });
  });

  it("finish POSTs /v2/orders/finish with { id } (money-free)", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: FINISH_OK }, calls),
    });

    const result = await client.orders.finish(90210);

    expect(new URL(calls[0]!.url).pathname).toBe("/v2/orders/finish");
    expect(bodyOf(calls[0]!)).toEqual({ id: 90210 });
    expect(result).toEqual({ order_id: 90210, status: "COMPLETED" });
  });

  it("resend POSTs /v2/orders/resend with { id } (money-free)", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: RESEND_OK }, calls),
    });

    const result = await client.orders.resend(90210);

    expect(new URL(calls[0]!.url).pathname).toBe("/v2/orders/resend");
    expect(bodyOf(calls[0]!)).toEqual({ id: 90210 });
    expect(result).toEqual({ order_id: 90210, status: "ACTIVE", resent: true });
  });
});

describe("orders.{cancel,finish,resend} — /v1 surface (IDR verbatim)", () => {
  it("cancel POSTs /v1/orders/cancel with { id } and returns IDR numbers", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V1_CANCEL_OK }, calls),
    });

    const result = await client.v1.orders.cancel(90210);

    expect(new URL(calls[0]!.url).pathname).toBe("/v1/orders/cancel");
    expect(bodyOf(calls[0]!)).toEqual({ id: 90210 });
    expect(result.refund_amount).toBe(750000);
    expect(result.new_balance).toBe(2000000);
    expect(result.status).toBe("CANCELED");
  });

  it("finish + resend route to the /v1 paths", async () => {
    const finishCalls: Captured[] = [];
    const finishClient = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: FINISH_OK }, finishCalls),
    });
    await finishClient.v1.orders.finish(90210);
    expect(new URL(finishCalls[0]!.url).pathname).toBe("/v1/orders/finish");

    const resendCalls: Captured[] = [];
    const resendClient = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: RESEND_OK }, resendCalls),
    });
    await resendClient.v1.orders.resend(90210);
    expect(new URL(resendCalls[0]!.url).pathname).toBe("/v1/orders/resend");
  });
});

describe("orders mutations — NO auto-retry (no idempotency key)", () => {
  it("a network failure is attempted EXACTLY ONCE, even with maxRetries set", async () => {
    for (const op of ["cancel", "finish", "resend"] as const) {
      let attempts = 0;
      const calls: Captured[] = [];
      const client = new SmscodeClient({
        token: "t",
        maxRetries: 5,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          attempts++;
          calls.push({ url: String(input), init: init ?? {} });
          return Promise.reject(new TypeError("connection reset"));
        }) as typeof fetch,
      });

      await client.orders[op](90210).catch(() => undefined);

      expect(attempts, `${op} must not auto-retry`).toBe(1);
      // No idempotency key is ever attached to a state mutation.
      expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBeNull();
    }
  });

  it("a 503 is NOT retried for a mutation (surfaces as a thrown error)", async () => {
    let attempts = 0;
    const client = new SmscodeClient({
      token: "t",
      maxRetries: 5,
      fetch: (() => {
        attempts++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: false,
              error: { code: "SERVICE_UNAVAILABLE", message: "down" },
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0",
              },
            },
          ),
        );
      }) as typeof fetch,
    });

    const err = (await client.orders
      .cancel(90210)
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
    expect(attempts).toBe(1);
  });

  it("a 409 CONFLICT (e.g. not finishable) propagates as the typed error", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        status: 409,
        body: {
          success: false,
          error: { code: "CONFLICT", message: "not finishable" },
        },
      }),
    });

    const err = (await client.orders
      .finish(90210)
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("CONFLICT");
    expect(err.httpStatus).toBe(409);
  });
});

describe("orders /v2 reads — TYPED error on a malformed 2xx envelope (swarm note)", () => {
  // A `/v2` order summary with valid money but NO `meta.fx` on the 2xx envelope.
  // These are reads — no idempotency key is involved (do NOT assert one).
  const V2_ORDER_OK = {
    id: 90210,
    status: "ACTIVE",
    product_id: 1024,
    catalog_product_id: 88,
    amount: {
      amount: "0.5000",
      currency: "USD",
      canonical_amount: 8000,
      canonical_currency: "IDR",
    },
  };

  it("get(): a 2xx envelope MISSING meta.fx throws a TYPED SmscodeError (INVALID_RESPONSE), not a raw TypeError", async () => {
    const client = new SmscodeClient({
      token: "t",
      // success: true, data present, but NO `meta` → no FX receipt.
      fetch: fakeFetch({ body: { success: true, data: V2_ORDER_OK } }),
    });

    const err = (await client.orders.get(90210).catch((e: unknown) => e)) as unknown;
    // The contract guarantee: a typed SDK error, never a bare TypeError.
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as SmscodeError).code).toBe("INVALID_RESPONSE");
    // Reads carry NO idempotency key.
    expect((err as SmscodeError).idempotencyKey).toBeUndefined();
  });

  it("list(): a 2xx envelope MISSING meta.fx throws a TYPED SmscodeError (INVALID_RESPONSE), not a raw TypeError", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: { success: true, data: [V2_ORDER_OK] } }),
    });

    const err = (await client.orders.list().catch((e: unknown) => e)) as unknown;
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as SmscodeError).code).toBe("INVALID_RESPONSE");
    expect((err as SmscodeError).idempotencyKey).toBeUndefined();
  });

  it("get(): a 2xx envelope with meta.fx but MISSING amount throws a TYPED SmscodeError (INVALID_MONEY), not a raw TypeError", async () => {
    const orderNoAmount = {
      id: 90210,
      status: "ACTIVE",
      product_id: 1024,
      catalog_product_id: 88,
      // No `amount` field at all → parseMoney(undefined) must throw INVALID_MONEY.
    };
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: orderNoAmount,
          meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
        },
      }),
    });

    const err = (await client.orders.get(90210).catch((e: unknown) => e)) as unknown;
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as SmscodeError).code).toBe("INVALID_MONEY");
  });

  it("cancel(): a 2xx envelope MISSING meta.fx throws a TYPED SmscodeError (INVALID_RESPONSE), not a raw TypeError", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          // Money fields present, but NO `meta` → no FX receipt.
          data: {
            order_id: 90210,
            status: "CANCELED",
            refund_amount: {
              amount: "0.5000",
              currency: "USD",
              canonical_amount: 750000,
              canonical_currency: "IDR",
            },
            new_balance: {
              amount: "1.25",
              currency: "USD",
              canonical_amount: 2000000,
              canonical_currency: "IDR",
            },
          },
        },
      }),
    });

    const err = (await client.orders.cancel(90210).catch((e: unknown) => e)) as unknown;
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as SmscodeError).code).toBe("INVALID_RESPONSE");
    // Cancel carries NO idempotency key.
    expect((err as SmscodeError).idempotencyKey).toBeUndefined();
  });
});
