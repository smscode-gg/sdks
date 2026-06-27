import { describe, expect, it } from "vitest";

import { SmscodeClient } from "../src/client.js";
import {
  NetworkError,
  RateLimitError,
  SmscodeError,
  TimeoutError,
  UnauthorizedError,
} from "../src/errors.js";

/** A recorded request, captured by a fake fetch. */
interface Captured {
  url: string;
  init: RequestInit;
}

/**
 * Build a fake fetch that records the call and returns a fixed JSON response.
 * This exercises the REAL client code path (URL build, headers, envelope parse),
 * not a mock of the client.
 */
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

describe("SmscodeClient.request — happy path", () => {
  it("carries Authorization: Bearer <token>", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: { success: true, data: { ok: true } } }, calls),
    });

    await client.request("GET", "/v2/balance");

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer t");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("builds the URL against baseUrl with a query string", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: { success: true, data: [] } }, calls),
    });

    await client.request("GET", "/v2/orders", {
      query: { status: "active", limit: 20, skip: undefined },
    });

    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://api.smscode.gg");
    expect(url.pathname).toBe("/v2/orders");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("limit")).toBe("20");
    // undefined query values are omitted
    expect(url.searchParams.has("skip")).toBe(false);
  });

  it("honors a custom baseUrl (trailing slash tolerated)", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      baseUrl: "https://api.example.test/",
      fetch: fakeFetch({ body: { success: true, data: {} } }, calls),
    });

    await client.request("GET", "/v2/balance");
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://api.example.test");
    expect(url.pathname).toBe("/v2/balance");
  });

  it("serializes a JSON body for POST", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: { success: true, data: {} } }, calls),
    });

    await client.request("POST", "/v2/orders/create", {
      body: { catalog_product_id: "abc" },
    });

    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ catalog_product_id: "abc" }));
  });

  it("returns the parsed envelope and captures X-Request-Id", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: { success: true, data: { balance: 100 } },
        headers: { "X-Request-Id": "rid-123" },
      }),
    });

    const result = await client.request<{ balance: number }>(
      "GET",
      "/v2/balance",
    );
    expect(result.data).toEqual({ balance: 100 });
    expect(result.requestId).toBe("rid-123");
  });
});

describe("SmscodeClient.request — error mapping", () => {
  it("maps a success:false envelope to the typed error", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        status: 401,
        body: {
          success: false,
          error: { code: "UNAUTHORIZED", message: "Authentication required" },
        },
        headers: { "X-Request-Id": "rid-401" },
      }),
    });

    await expect(client.request("GET", "/v2/balance")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
      requestId: "rid-401",
    });
    await expect(client.request("GET", "/v2/balance")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("reads Retry-After into RateLimitError on 429", async () => {
    const client = new SmscodeClient({
      token: "t",
      maxRetries: 0,
      fetch: fakeFetch({
        status: 429,
        body: {
          success: false,
          error: { code: "RATE_LIMIT_EXCEEDED", message: "Slow down" },
        },
        headers: { "Retry-After": "7" },
      }),
    });

    await expect(client.request("GET", "/v2/balance")).rejects.toMatchObject({
      retryAfterSeconds: 7,
    });
    await expect(client.request("GET", "/v2/balance")).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("maps a non-2xx with non-JSON body by status", async () => {
    const client = new SmscodeClient({
      token: "t",
      // 413 with an HTML/plain body — parse must not throw, falls back by status.
      fetch: (async () =>
        new Response("<html>too big</html>", {
          status: 413,
          headers: { "Content-Type": "text/html" },
        })) as typeof fetch,
    });

    await expect(client.request("POST", "/v2/orders/create")).rejects.toMatchObject(
      { httpStatus: 413 },
    );
  });
});

describe("SmscodeClient.request — transport", () => {
  it("wraps a fetch rejection in NetworkError", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    await expect(client.request("GET", "/v2/balance")).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("raises TimeoutError when the request exceeds timeoutMs", async () => {
    // A fetch that only settles when its signal aborts → exercises the AbortSignal timeout path.
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

    await expect(client.request("GET", "/v2/balance")).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("retries a 503 then succeeds (maxRetries)", async () => {
    let attempts = 0;
    const flakyFetch = (async () => {
      attempts++;
      if (attempts < 2) {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "down" },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SmscodeClient({
      token: "t",
      maxRetries: 2,
      fetch: flakyFetch,
    });

    const result = await client.request("GET", "/v2/balance");
    expect(result.data).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });
});

describe("resource tree — surface routing (/v2 default, /v1 namespace)", () => {
  it("client.catalog.products() hits /v2/catalog/products by default", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch(
        {
          body: {
            success: true,
            data: [],
            meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
          },
        },
        calls,
      ),
    });

    await client.catalog.products();

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/catalog/products");
  });

  it("client.v1.catalog.products() hits /v1/catalog/products", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch(
        {
          body: {
            success: true,
            data: [],
            meta: { page: 1, limit: 1000, count: 0 },
          },
        },
        calls,
      ),
    });

    await client.v1.catalog.products();

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/catalog/products");
  });

  it("forwards catalog query params (country_id, platform_id, page, sort)", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch(
        {
          body: {
            success: true,
            data: [],
            meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
          },
        },
        calls,
      ),
    });

    await client.catalog.products({
      country_id: 6,
      platform_id: 1,
      page: 2,
      sort: "price_desc",
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/catalog/products");
    expect(url.searchParams.get("country_id")).toBe("6");
    expect(url.searchParams.get("platform_id")).toBe("1");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("sort")).toBe("price_desc");
  });

  it("client.catalog.countries() / services() route to /v2 paths", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: { success: true, data: [] } }, calls),
    });

    await client.catalog.countries();
    await client.catalog.services({ country_id: 6 });

    expect(new URL(calls[0]!.url).pathname).toBe("/v2/catalog/countries");
    const svc = new URL(calls[1]!.url);
    expect(svc.pathname).toBe("/v2/catalog/services");
    expect(svc.searchParams.get("country_id")).toBe("6");
  });

  it("client.v1.catalog.countries() routes to /v1/catalog/countries", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: { success: true, data: [] } }, calls),
    });

    await client.v1.catalog.countries();
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/catalog/countries");
  });

  it("client.orders.list() / active() route to /v2 order paths", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch(
        {
          body: {
            success: true,
            data: [],
            meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
          },
        },
        calls,
      ),
    });

    await client.orders.list({ status: "ACTIVE", limit: 10 });
    await client.orders.active();

    const list = new URL(calls[0]!.url);
    expect(list.pathname).toBe("/v2/orders");
    expect(list.searchParams.get("status")).toBe("ACTIVE");
    expect(list.searchParams.get("limit")).toBe("10");
    expect(new URL(calls[1]!.url).pathname).toBe("/v2/orders/active");
  });

  it("client.v1.orders.list() routes to /v1/orders", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: { success: true, data: [] } }, calls),
    });

    await client.v1.orders.list();
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/orders");
  });

  it("client.orders.get(id) interpolates the path", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch(
        {
          body: {
            success: true,
            data: {
              id: 90210,
              status: "ACTIVE",
              product_id: 1024,
              amount: {
                amount: "46.88",
                currency: "USD",
                canonical_amount: 750000,
                canonical_currency: "IDR",
              },
            },
            meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
          },
        },
        calls,
      ),
    });

    await client.orders.get(90210);
    expect(new URL(calls[0]!.url).pathname).toBe("/v2/orders/90210");
  });
});

describe("resource tree — money projection", () => {
  it("a /v2 order's `amount` comes back as a parsed V2Money", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: {
            id: 90210,
            status: "COMPLETED",
            product_id: 1024,
            amount: {
              amount: "46.88",
              currency: "USD",
              canonical_amount: 750000,
              canonical_currency: "IDR",
            },
          },
          meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
        },
      }),
    });

    const order = await client.orders.get(90210);
    expect(order.amount).toEqual({
      amount: "46.88",
      currency: "USD",
      canonicalAmount: 750000,
      canonicalAmountRaw: "750000",
      canonicalCurrency: "IDR",
    });
    // The FX receipt from `meta` is surfaced on the order result.
    expect(order.fx).toEqual({ pair: "USD/IDR", rate: 16000, rate_as_of: null });
  });

  it("a /v2 balance comes back as a parsed V2Money + fx", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: {
            balance: {
              amount: "78.13",
              currency: "USD",
              canonical_amount: 1250000,
              canonical_currency: "IDR",
            },
          },
          meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
        },
      }),
    });

    const balance = await client.balance.get();
    expect(balance.balance.canonicalAmount).toBe(1250000);
    expect(balance.balance.canonicalAmountRaw).toBe("1250000");
    expect(balance.balance.amount).toBe("78.13");
    expect(balance.fx.rate).toBe(16000);
  });

  it("a /v2 products page projects each product's price to V2Money", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: [
            {
              id: 1024,
              available: 142,
              active: true,
              price: {
                amount: "46.88",
                currency: "USD",
                canonical_amount: 750000,
                canonical_currency: "IDR",
              },
            },
          ],
          meta: { page: 1, limit: 1000, count: 1, fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
        },
      }),
    });

    const page = await client.catalog.products();
    expect(page.products[0]!.price.canonicalAmount).toBe(750000);
    expect(page.products[0]!.price.amount).toBe("46.88");
    expect(page.meta.count).toBe(1);
    expect(page.fx.rate).toBe(16000);
  });

  it("the /v1 namespace returns IDR as a plain number (no parseMoney)", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: { currency: "IDR", balance: 1250000 },
        },
      }),
    });

    const balance = await client.v1.balance.get();
    expect(balance.balance).toBe(1250000);
    expect(balance.currency).toBe("IDR");
  });

  it("a /v1 order's `amount` stays a plain IDR number", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: {
            id: 90210,
            status: "COMPLETED",
            product_id: 1024,
            amount: 750000,
          },
        },
      }),
    });

    const order = await client.v1.orders.get(90210);
    expect(order.amount).toBe(750000);
  });

  it("client.v1.catalog.exchangeRate() returns the V1ExchangeRate shape", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: {
            pair: "USD/IDR",
            base_currency: "USD",
            quote_currency: "IDR",
            rate: 16000,
          },
        },
      }),
    });

    const rate = await client.v1.catalog.exchangeRate();
    expect(rate.rate).toBe(16000);
    expect(rate.pair).toBe("USD/IDR");
  });

  it("client.catalog.exchangeRate() returns the V2Fx receipt", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          data: { pair: "USD/IDR", rate: 16000, rate_as_of: null },
        },
      }),
    });

    const fx = await client.catalog.exchangeRate();
    expect(fx.rate).toBe(16000);
    expect(fx.pair).toBe("USD/IDR");
  });
});

describe("/v2 reads — TYPED error on a malformed 2xx envelope (shared requireFx)", () => {
  // The shared `requireFx` (src/internal/decode.ts) closes the whole malformed-2xx
  // `meta.fx` class: a 2xx success envelope that omits `meta.fx` must surface a
  // TYPED SmscodeError("INVALID_RESPONSE"), never a raw `TypeError` from a bare
  // `(result.meta as …).fx` deref. These are reads — no idempotency key is
  // involved (so it must be undefined on the thrown error).

  it("balance.get(): a 2xx envelope MISSING meta.fx throws a TYPED SmscodeError (INVALID_RESPONSE), not a raw TypeError", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          // Money present, but NO `meta` → no FX receipt. A bare
          // `(result.meta as V2Meta).fx` would have raw-`TypeError`d here.
          data: {
            balance: {
              amount: "78.13",
              currency: "USD",
              canonical_amount: 1250000,
              canonical_currency: "IDR",
            },
          },
        },
      }),
    });

    const err = (await client.balance.get().catch((e: unknown) => e)) as unknown;
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as SmscodeError).code).toBe("INVALID_RESPONSE");
    // Reads carry NO idempotency key.
    expect((err as SmscodeError).idempotencyKey).toBeUndefined();
  });

  it("balance.get(): a 2xx envelope with meta.fx but MISSING balance throws a TYPED SmscodeError (INVALID_MONEY), not a raw TypeError", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          // FX receipt present, but NO `balance` field → parseMoney(undefined)
          // must throw INVALID_MONEY (not a raw TypeError).
          data: {},
          meta: { fx: { pair: "USD/IDR", rate: 16000, rate_as_of: null } },
        },
      }),
    });

    const err = (await client.balance.get().catch((e: unknown) => e)) as unknown;
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as SmscodeError).code).toBe("INVALID_MONEY");
  });

  it("catalog.products(): a 2xx envelope MISSING meta.fx throws a TYPED SmscodeError (INVALID_RESPONSE), not a raw TypeError", async () => {
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({
        body: {
          success: true,
          // A product page with valid prices but NO `meta` → no FX receipt. A
          // bare `meta.fx` deref would have raw-`TypeError`d here.
          data: [
            {
              id: 1024,
              available: 142,
              active: true,
              price: {
                amount: "46.88",
                currency: "USD",
                canonical_amount: 750000,
                canonical_currency: "IDR",
              },
            },
          ],
        },
      }),
    });

    const err = (await client.catalog
      .products()
      .catch((e: unknown) => e)) as unknown;
    expect(err).toBeInstanceOf(SmscodeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as SmscodeError).code).toBe("INVALID_RESPONSE");
    expect((err as SmscodeError).idempotencyKey).toBeUndefined();
  });
});
