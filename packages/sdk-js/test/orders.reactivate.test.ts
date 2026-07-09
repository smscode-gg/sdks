/**
 * Order reactivation (`reactivate` + `reactivateOptions`).
 *
 * `reactivate` re-orders (buys another SMS on) a completed HERO number. It is a
 * MONEY mutation and mirrors `create` EXACTLY on the idempotency contract: the
 * key is resolved up front, sent on the `idempotency-key` header, retried only on
 * transient failures with the SAME key, attached to the success result, and
 * stamped onto EVERY thrown error. It returns the SAME create-result shape (the
 * ONE reactivated child order): `/v2` projects `amount` to a USD {@link Money} and
 * carries the FX receipt; `/v1` returns the IDR amount verbatim.
 *
 * `reactivateOptions` is a read-only cost PREVIEW (NO idempotency key): `/v2`
 * returns the cost as a USD {@link Money} + the FX receipt; `/v1` returns the IDR
 * integer cost.
 *
 * Tests drive the REAL client path via an injected fetch mock.
 */
import { describe, expect, it } from "vitest";

import { SmscodeClient } from "../src/client.js";
import { SmscodeError, ValidationError } from "../src/errors.js";

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

/** Read the `idempotency-key` header off a captured request. */
function keyHeader(call: Captured): string | null {
  return new Headers(call.init.headers).get("idempotency-key");
}

/** The server-authoritative caps of a freshly reactivated (age ~0) child order. */
const FRESH_CAPS = {
  can_finish: false,
  can_resend: false,
  can_cancel: false,
  can_replace: false,
  can_reactivate: false,
  resend_available_at: null,
  cancel_available_at: null,
  replace_available_at: null,
};

/** A successful `/v2` reactivate envelope (one child order + the FX receipt). */
const V2_REACTIVATE_OK = {
  success: true,
  data: {
    orders: [
      {
        id: 90211,
        status: "ACTIVE",
        product_id: 1024,
        catalog_product_id: 88,
        amount: {
          amount: "0.5000",
          currency: "USD",
          canonical_amount: 8000,
          canonical_currency: "IDR",
        },
        ...FRESH_CAPS,
      },
    ],
    failed_count: 0,
  },
  meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
};

/** A successful `/v1` reactivate envelope (one child order, IDR amount). */
const V1_REACTIVATE_OK = {
  success: true,
  data: {
    orders: [
      {
        id: 90211,
        status: "ACTIVE",
        product_id: 1024,
        catalog_product_id: 88,
        amount: 8000,
        ...FRESH_CAPS,
      },
    ],
    failed_count: 0,
  },
};

/** A `/v2` reactivate-options preview (cost as a USD Money + the FX receipt). */
const V2_OPTIONS_OK = {
  success: true,
  data: {
    cost: {
      amount: "0.5000",
      currency: "USD",
      canonical_amount: 8000,
      canonical_currency: "IDR",
    },
  },
  meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
};

/** A `/v1` reactivate-options preview (IDR integer cost). */
const V1_OPTIONS_OK = {
  success: true,
  data: { cost: 8000 },
};

describe("orders.reactivate — /v2 default surface (money-safety idempotency)", () => {
  it("no key → generated key on the header AND on the result; projects Money + fx", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_REACTIVATE_OK }, calls),
    });

    const result = await client.orders.reactivate(90210);

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/v2/orders/reactivate");
    expect(calls[0]!.init.method).toBe("POST");
    // The body is just { id } when no max_price is supplied.
    expect(bodyOf(calls[0]!)).toEqual({ id: 90210 });
    const header = keyHeader(calls[0]!);
    expect(header).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(result.idempotencyKey).toBe(header);
    // The reactivated child amount is projected to a USD Money + the FX receipt.
    expect(result.orders[0]!.amount).toEqual({
      amount: "0.5000",
      currency: "USD",
      canonicalAmount: 8000,
      canonicalAmountRaw: "8000",
      canonicalCurrency: "IDR",
    });
    expect(result.orders[0]!.id).toBe(90211);
    expect(result.fx).toEqual({ pair: "USD/IDR", rate: 16000, rate_as_of: null });
    expect(result.failed_count).toBe(0);
  });

  it("a USD-decimal max_price + provided key ride the body/header verbatim", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_REACTIVATE_OK }, calls),
    });

    const result = await client.orders.reactivate(90210, {
      max_price: "0.75",
      idempotencyKey: "react-key_1",
    });

    expect(bodyOf(calls[0]!)).toEqual({ id: 90210, max_price: "0.75" });
    expect(keyHeader(calls[0]!)).toBe("react-key_1");
    expect(result.idempotencyKey).toBe("react-key_1");
  });

  it("an invalid provided key throws ValidationError and sends NO request", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_REACTIVATE_OK }, calls),
    });

    await expect(
      client.orders.reactivate(90210, { idempotencyKey: "bad key!" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("MONEY-SAFETY: a 422 error carries the resolved idempotency key", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        status: 422,
        body: {
          success: false,
          error: { code: "IDEMPOTENCY_KEY_REUSED", message: "reused" },
        },
      }),
    });

    const err = (await client.orders
      .reactivate(90210, { idempotencyKey: "stamp-me_1" })
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(err.idempotencyKey).toBe("stamp-me_1");
  });
});

describe("orders.reactivate — /v1 surface (IDR verbatim)", () => {
  it("routes to /v1/orders/reactivate with an IDR-integer max_price + key on header/result", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V1_REACTIVATE_OK }, calls),
    });

    const result = await client.v1.orders.reactivate(90210, {
      max_price: 800000,
      idempotencyKey: "v1-react_1",
    });

    expect(new URL(calls[0]!.url).pathname).toBe("/v1/orders/reactivate");
    expect(bodyOf(calls[0]!)).toEqual({ id: 90210, max_price: 800000 });
    expect(keyHeader(calls[0]!)).toBe("v1-react_1");
    // /v1 amount stays a plain IDR number; the key is on the result.
    expect(result.orders[0]!.amount).toBe(8000);
    expect(result.idempotencyKey).toBe("v1-react_1");
  });
});

describe("orders.reactivateOptions — read-only cost preview (NO idempotency key)", () => {
  it("/v2 GETs /v2/orders/{id}/reactivate-options → cost Money + fx, no key header", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_OPTIONS_OK }, calls),
    });

    const preview = await client.orders.reactivateOptions(90210);

    expect(new URL(calls[0]!.url).pathname).toBe("/v2/orders/90210/reactivate-options");
    expect(calls[0]!.init.method).toBe("GET");
    expect(keyHeader(calls[0]!)).toBeNull();
    expect(preview.cost).toEqual({
      amount: "0.5000",
      currency: "USD",
      canonicalAmount: 8000,
      canonicalAmountRaw: "8000",
      canonicalCurrency: "IDR",
    });
    expect(preview.fx).toEqual({ pair: "USD/IDR", rate: 16000, rate_as_of: null });
  });

  it("/v2 preview MISSING meta.fx throws a TYPED INVALID_RESPONSE (not a raw TypeError)", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: {
            cost: {
              amount: "0.5000",
              currency: "USD",
              canonical_amount: 8000,
              canonical_currency: "IDR",
            },
          },
        },
      }),
    });

    const err = (await client.orders
      .reactivateOptions(90210)
      .catch((e: unknown) => e)) as unknown;
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as SmscodeError).code).toBe("INVALID_RESPONSE");
  });

  it("/v1 GETs /v1/orders/{id}/reactivate-options → IDR integer cost", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V1_OPTIONS_OK }, calls),
    });

    const preview = await client.v1.orders.reactivateOptions(90210);

    expect(new URL(calls[0]!.url).pathname).toBe("/v1/orders/90210/reactivate-options");
    expect(calls[0]!.init.method).toBe("GET");
    expect(keyHeader(calls[0]!)).toBeNull();
    expect(preview.cost).toBe(8000);
  });
});

describe("orders — can_reactivate capability is surfaced on order reads", () => {
  it("get() carries the server-authoritative can_reactivate flag through", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: {
            id: 90210,
            status: "COMPLETED",
            product_id: 1024,
            catalog_product_id: 88,
            amount: {
              amount: "0.5000",
              currency: "USD",
              canonical_amount: 8000,
              canonical_currency: "IDR",
            },
            can_finish: false,
            can_resend: false,
            can_cancel: false,
            can_replace: false,
            can_reactivate: true,
            resend_available_at: null,
            cancel_available_at: null,
            replace_available_at: null,
          },
          meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
        },
      }),
    });

    const order = await client.orders.get(90210);
    expect(order.can_reactivate).toBe(true);
  });
});
