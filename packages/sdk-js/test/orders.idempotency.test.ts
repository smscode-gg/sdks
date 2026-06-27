/**
 * Money-safety: order-create idempotency.
 *
 * The single most important property of the SDK: a retried (or failed) order
 * create must NEVER mint a fresh idempotency key. The resolved key is attached to
 * the request header, to the success result, AND to EVERY thrown error — typed API
 * errors (422/409/…), transport errors (network/timeout/abort), and the final
 * retry-exhaustion throw — so the caller can always safely retry with the SAME key.
 *
 * These tests exercise the REAL client code path (URL build, headers, envelope
 * parse, error mapping, retry) via an injected fake fetch — not a mock of the
 * client itself.
 */
import { describe, expect, it } from "vitest";

import { SmscodeClient } from "../src/client.js";
import { SmscodeError, ValidationError } from "../src/errors.js";
import { resolveKey } from "../src/idempotency.js";

/** A recorded request, captured by a fake fetch. */
interface Captured {
  url: string;
  init: RequestInit;
}

/** The standard pattern the server enforces (spec §3.0). */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A successful `/v2` create envelope (one order, with the FX receipt). */
const V2_CREATE_OK = {
  success: true,
  data: {
    orders: [
      {
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
      },
    ],
    failed_count: 0,
  },
  meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
};

/** A successful `/v1` create envelope (one order, IDR amount). */
const V1_CREATE_OK = {
  success: true,
  data: {
    orders: [
      {
        id: 90210,
        status: "ACTIVE",
        product_id: 1024,
        catalog_product_id: 88,
        amount: 8000,
      },
    ],
    failed_count: 0,
  },
};

/**
 * A `success: true` `/v1` create envelope with `data` entirely ABSENT. The `/v1`
 * decode spreads `result.data`, and `...(undefined)` is a SILENT no-op (no throw),
 * so a contract-violating 2xx would otherwise yield a broken `{ idempotencyKey }`
 * result instead of a typed error. The decode must validate the envelope shape.
 */
const V1_CREATE_OK_NO_DATA = {
  success: true,
  // No `data` key at all → the decode's `...(result.data)` spread is a no-op.
};

/**
 * A `success: true` `/v2` create envelope whose `canonical_amount` is an UNSAFE
 * integer (`Number.MAX_SAFE_INTEGER + 1` as a raw JSON number). The server may
 * already have placed/debited the order, yet `parseMoney` rejects it — the throw
 * happens during the SUCCESS decode, AFTER the request boundary.
 */
const V2_CREATE_OK_UNSAFE_AMOUNT = {
  success: true,
  data: {
    orders: [
      {
        id: 90210,
        status: "ACTIVE",
        product_id: 1024,
        catalog_product_id: 88,
        amount: {
          amount: "0.5000",
          currency: "USD",
          // 9007199254740992 = Number.MAX_SAFE_INTEGER + 1 (not a safe integer).
          canonical_amount: Number.MAX_SAFE_INTEGER + 1,
          canonical_currency: "IDR",
        },
      },
    ],
    failed_count: 0,
  },
  meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
};

/**
 * A `success: true` `/v2` create envelope with `meta` entirely ABSENT (no FX
 * receipt). Reading `result.meta.fx` would throw a raw `TypeError`; the decode
 * must instead validate the envelope and throw a TYPED {@link SmscodeError}.
 */
const V2_CREATE_OK_NO_META = {
  success: true,
  data: {
    orders: [
      {
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
      },
    ],
    failed_count: 0,
  },
  // No `meta` key at all → no FX receipt on a 200 success.
};

/**
 * A `success: true` `/v2` create envelope with valid `meta.fx` but an order item
 * MISSING its `amount` field. `parseMoney(undefined)` now throws a typed
 * `INVALID_MONEY` `SmscodeError`, and that error still needs the resolved
 * idempotency key stamped onto it because the server returned 200 (the order may
 * be placed/debited). The caller must be able to replay the SAME key; a fresh
 * key could double charge.
 */
const V2_CREATE_OK_MISSING_AMOUNT = {
  success: true,
  data: {
    orders: [
      {
        id: 90210,
        status: "ACTIVE",
        product_id: 1024,
        catalog_product_id: 88,
        // No `amount` field at all → parseMoney(undefined) throws typed INVALID_MONEY.
      },
    ],
    failed_count: 0,
  },
  meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
};

/** Build a fake fetch returning a fixed JSON response, recording every call. */
function fakeFetch(
  response: {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  },
  sink?: Captured[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    sink?.push({ url: String(input), init: init ?? {} });
    const status = response.status ?? 200;
    const headers = new Headers({
      "Content-Type": "application/json",
      ...response.headers,
    });
    const text =
      response.body === undefined ? "" : JSON.stringify(response.body);
    return new Response(text, { status, headers });
  }) as typeof fetch;
}

/** Read the `idempotency-key` header off a captured request. */
function keyHeader(call: Captured): string | null {
  return new Headers(call.init.headers).get("idempotency-key");
}

describe("resolveKey — up-front key resolution", () => {
  it("generates a UUIDv4-shaped key when none is provided", () => {
    const key = resolveKey();
    expect(key).toMatch(KEY_PATTERN);
    // UUIDv4 canonical form.
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns a generated key that differs across calls", () => {
    expect(resolveKey()).not.toBe(resolveKey());
  });

  it("returns a valid caller-provided key verbatim", () => {
    expect(resolveKey("order-2026-06-23_abc")).toBe("order-2026-06-23_abc");
  });

  it("throws ValidationError on an invalid provided key (BEFORE any work)", () => {
    expect(() => resolveKey("bad key!")).toThrow(ValidationError);
    expect(() => resolveKey("")).toThrow(ValidationError);
    expect(() => resolveKey("a".repeat(129))).toThrow(ValidationError);
  });
});

describe("orders.create — key on header + success result (/v2 default)", () => {
  it("no key → generated key on the header matches the pattern AND is on the result", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_CREATE_OK }, calls),
    });

    const result = await client.orders.create({ catalog_product_id: 88 });

    expect(calls).toHaveLength(1);
    const header = keyHeader(calls[0]!);
    expect(header).toMatch(KEY_PATTERN);
    expect(result.idempotencyKey).toBe(header);
    // The create routed to the /v2 path.
    expect(new URL(calls[0]!.url).pathname).toBe("/v2/orders/create");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("a caller-provided valid key is used verbatim on the header + result", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_CREATE_OK }, calls),
    });

    const result = await client.orders.create(
      { catalog_product_id: 88 },
      { idempotencyKey: "my-fixed-key_123" },
    );

    expect(keyHeader(calls[0]!)).toBe("my-fixed-key_123");
    expect(result.idempotencyKey).toBe("my-fixed-key_123");
  });

  it("projects each order amount to a USD Money object + carries fx", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_CREATE_OK }),
    });

    const result = await client.orders.create({ catalog_product_id: 88 });
    expect(result.orders[0]!.amount).toEqual({
      amount: "0.5000",
      currency: "USD",
      canonicalAmount: 8000,
      canonicalAmountRaw: "8000",
      canonicalCurrency: "IDR",
    });
    expect(result.fx).toEqual({ pair: "USD/IDR", rate: 16000, rate_as_of: null });
    expect(result.failed_count).toBe(0);
  });

  it("an invalid provided key throws ValidationError and sends NO request", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_CREATE_OK }, calls),
    });

    await expect(
      client.orders.create(
        { catalog_product_id: 88 },
        { idempotencyKey: "bad key!" },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    // CRITICAL: the fetch mock must never have been called.
    expect(calls).toHaveLength(0);
  });
});

describe("orders.create — /v1 surface", () => {
  it("routes to /v1/orders/create with an IDR number max_price + key on header/result", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V1_CREATE_OK }, calls),
    });

    const result = await client.v1.orders.create(
      { catalog_product_id: 88, max_price: 800000 },
      { idempotencyKey: "v1-key_1" },
    );

    expect(new URL(calls[0]!.url).pathname).toBe("/v1/orders/create");
    expect(keyHeader(calls[0]!)).toBe("v1-key_1");
    // The body carried the IDR integer max_price verbatim.
    const sent = JSON.parse(String(calls[0]!.init.body)) as {
      max_price?: number;
    };
    expect(sent.max_price).toBe(800000);
    // /v1 amount stays a plain IDR number; the key is on the result.
    expect(result.orders[0]!.amount).toBe(8000);
    expect(result.idempotencyKey).toBe("v1-key_1");
  });
});

describe("MONEY-SAFETY: the resolved key is on EVERY thrown error", () => {
  /** Build a client whose fetch returns a fixed failure envelope. */
  function failingClient(
    status: number,
    code: string,
    calls?: Captured[],
  ): SmscodeClient {
    return new SmscodeClient({
      token: "t",
      fetch: fakeFetch(
        {
          status,
          body: { success: false, error: { code, message: code } },
        },
        calls,
      ),
    });
  }

  const PROVIDED = "stable-key_for-error-paths";

  it("422 IDEMPOTENCY_KEY_REUSED carries the resolved key", async () => {
    const client = failingClient(422, "IDEMPOTENCY_KEY_REUSED");
    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(err.idempotencyKey).toBe(PROVIDED);
  });

  it("409 REQUEST_IN_PROGRESS carries the resolved key", async () => {
    const client = failingClient(409, "REQUEST_IN_PROGRESS");
    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("REQUEST_IN_PROGRESS");
    expect(err.idempotencyKey).toBe(PROVIDED);
  });

  it("409 INSUFFICIENT_BALANCE carries the resolved key", async () => {
    const client = failingClient(409, "INSUFFICIENT_BALANCE");
    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("INSUFFICIENT_BALANCE");
    expect(err.idempotencyKey).toBe(PROVIDED);
  });

  it("a network reject carries the resolved key", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.idempotencyKey).toBe(PROVIDED);
  });

  it("a timeout carries the resolved key", async () => {
    const slowFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          });
        }
      })) as typeof fetch;
    const client = new SmscodeClient({
      token: "t",
      timeoutMs: 10,
      fetch: slowFetch,
    });
    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("TIMEOUT");
    expect(err.idempotencyKey).toBe(PROVIDED);
  });

  it("a GENERATED key (no provided key) is also stamped on a thrown error", async () => {
    const calls: Captured[] = [];
    const client = failingClient(409, "INSUFFICIENT_BALANCE", calls);
    const err = (await client.orders
      .create({ catalog_product_id: 88 })
      .catch((e: unknown) => e)) as SmscodeError;
    // The stamped key equals the one actually sent on the header.
    expect(err.idempotencyKey).toBeDefined();
    expect(err.idempotencyKey).toMatch(KEY_PATTERN);
    expect(err.idempotencyKey).toBe(keyHeader(calls[0]!));
  });
});

describe("MONEY-SAFETY: retry exhaustion keeps the SAME key (never a new one)", () => {
  it("maxRetries:2, all attempts network-fail → final error carries the one key, identical across attempts", async () => {
    const sentKeys: string[] = [];
    const client = new SmscodeClient({
      token: "t",
      maxRetries: 2,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        const k = new Headers(init?.headers).get("idempotency-key");
        if (k !== null) sentKeys.push(k);
        return Promise.reject(new TypeError("fetch failed"));
      }) as typeof fetch,
    });

    const err = (await client.orders
      .create({ catalog_product_id: 88 })
      .catch((e: unknown) => e)) as SmscodeError;

    // 1 initial + 2 retries = 3 attempts.
    expect(sentKeys).toHaveLength(3);
    // The SAME key on every attempt (no fresh key minted on retry).
    expect(new Set(sentKeys).size).toBe(1);
    // The final thrown error carries that exact key.
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.idempotencyKey).toBe(sentKeys[0]);
  });

  it("a provided key stays identical across all retry attempts", async () => {
    const sentKeys: string[] = [];
    const client = new SmscodeClient({
      token: "t",
      maxRetries: 2,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        const k = new Headers(init?.headers).get("idempotency-key");
        if (k !== null) sentKeys.push(k);
        return Promise.reject(new TypeError("fetch failed"));
      }) as typeof fetch,
    });

    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: "fixed_retry-key" })
      .catch((e: unknown) => e)) as SmscodeError;

    expect(sentKeys).toEqual([
      "fixed_retry-key",
      "fixed_retry-key",
      "fixed_retry-key",
    ]);
    expect(err.idempotencyKey).toBe("fixed_retry-key");
  });
});

describe("MONEY-SAFETY: a POST-SUCCESS decode error still carries the key", () => {
  const PROVIDED = "stable-key";

  it("/v2 success with an UNSAFE canonical_amount → INVALID_MONEY error carries the resolved key", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_CREATE_OK_UNSAFE_AMOUNT }, calls),
    });

    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;

    // The server returned 200 (the order may already be placed/debited) but the
    // money decode threw — it MUST still be stamped so the caller can replay the
    // SAME key (a fresh key would risk a double charge).
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err.code).toBe("INVALID_MONEY");
    expect(err.idempotencyKey).toBe(PROVIDED);
    // The key on the wire was the same one stamped onto the error.
    expect(keyHeader(calls[0]!)).toBe(PROVIDED);
  });

  it("/v2 success with `meta` MISSING → a TYPED SmscodeError (not a raw TypeError) carries the resolved key", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_CREATE_OK_NO_META }),
    });

    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;

    // Must be a typed SDK error (so the stamping boundary catches it), NOT the
    // raw TypeError that `(result.meta as V2Meta).fx` would otherwise throw.
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.idempotencyKey).toBe(PROVIDED);
  });

  it("/v2 success with valid meta.fx but an order item MISSING `amount` → a TYPED SmscodeError (not a raw TypeError) carries the resolved key", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V2_CREATE_OK_MISSING_AMOUNT }, calls),
    });

    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;

    // Missing amount throws a typed INVALID_MONEY SmscodeError. The boundary still
    // must stamp the resolved key: the 200 means the order may be placed/debited,
    // so the caller must replay the SAME key (a fresh key would risk a double
    // charge).
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.idempotencyKey).toBe(PROVIDED);
    // The key on the wire was the same one stamped onto the error.
    expect(keyHeader(calls[0]!)).toBe(PROVIDED);
  });

  it("/v1 success with `data` MISSING → a TYPED INVALID_RESPONSE (not a silent broken result) carries the resolved key", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: V1_CREATE_OK_NO_DATA }, calls),
    });

    const err = (await client.v1.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: PROVIDED })
      .catch((e: unknown) => e)) as SmscodeError;

    // The `/v1` decode spreads `result.data`; `...(undefined)` is a SILENT no-op,
    // so pre-fix a malformed 2xx returned a broken `{ idempotencyKey }` instead of
    // throwing. The shape guard must throw a TYPED INVALID_RESPONSE — stamped with
    // the key (a 200 means the order may be placed/debited, so the caller must
    // replay the SAME key), mirroring the /v2 envelope guards.
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.code).toBe("INVALID_RESPONSE");
    expect(err.idempotencyKey).toBe(PROVIDED);
    expect(keyHeader(calls[0]!)).toBe(PROVIDED);
  });
});
