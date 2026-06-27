/**
 * Retry policy.
 *
 * - Reads (GET) retry transient failures (network / 429 / 503), honoring
 *   `Retry-After`.
 * - `orders.create` retries the SAME way, but the idempotency key is IDENTICAL on
 *   every attempt (dedup-replay on the server), so a retried create is at-most-once.
 * - A non-retryable business failure (422) is thrown immediately — never retried.
 * - The state-changing single-order ops (cancel/finish/resend) are NOT auto-retried
 *   (they carry no idempotency key, so a blind retry is unsafe).
 *
 * `withRetry` is exercised both directly (unit) and through the real client path.
 */
import { describe, expect, it, vi } from "vitest";

import { SmscodeClient } from "../src/client.js";
import { NetworkError, type SmscodeError } from "../src/errors.js";
import { withRetry } from "../src/retry.js";

/** A recorded request, captured by a fake fetch. */
interface Captured {
  url: string;
  init: RequestInit;
}

function captureKey(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("idempotency-key");
}

const V2_CREATE_OK = {
  success: true,
  data: {
    orders: [
      {
        id: 90210,
        status: "ACTIVE",
        product_id: 1024,
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

describe("withRetry — generic policy engine", () => {
  it("returns the value on first success (no retry)", async () => {
    const fn = vi.fn(async () => "ok");
    const out = await withRetry(fn, {
      maxRetries: 3,
      retryOn: () => true,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to maxRetries, then throws the last error", async () => {
    const fn = vi.fn(async () => {
      throw new NetworkError("boom");
    });
    await expect(
      withRetry(fn, { maxRetries: 2, retryOn: () => true, delayMs: () => 0 }),
    ).rejects.toBeInstanceOf(NetworkError);
    // 1 initial + 2 retries.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry when retryOn returns false", async () => {
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(
      withRetry(fn, { maxRetries: 5, retryOn: () => false }),
    ).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors a retryAfter delay (seconds) over the backoff", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw new NetworkError("retry me");
      return "done";
    });
    const sleeps: number[] = [];
    const out = await withRetry(fn, {
      maxRetries: 2,
      retryOn: () => true,
      retryAfter: () => 3, // seconds
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(out).toBe("done");
    // 3 seconds → 3000 ms, taking precedence over exponential backoff.
    expect(sleeps).toEqual([3000]);
  });

  it("uses a growing exponential-backoff ceiling when no retryAfter is given", async () => {
    const fn = vi.fn(async () => {
      throw new NetworkError("always");
    });
    const sleeps: number[] = [];
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        retryOn: () => true,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    // Three retry waits. The default backoff is capped exponential with FULL
    // JITTER (random(0, base*2^(n-1))), so the SAMPLED values are not monotonic;
    // the invariant is that each wait is non-negative and within its (growing)
    // ceiling. base=250ms → ceilings 250, 500, 1000.
    expect(sleeps).toHaveLength(3);
    const ceilings = [250, 500, 1000];
    sleeps.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(ceilings[i]!);
    });
  });

  it("the default backoff ceiling grows monotonically with the attempt (jitter aside)", async () => {
    // Assert the deterministic property of the engine's default delay directly:
    // run with a fixed RNG so the ceiling growth is observable without flakiness.
    const original = Math.random;
    Math.random = () => 1; // sample the exact ceiling each time
    try {
      const sleeps: number[] = [];
      const fn = vi.fn(async () => {
        throw new NetworkError("always");
      });
      await expect(
        withRetry(fn, {
          maxRetries: 3,
          retryOn: () => true,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        }),
      ).rejects.toBeInstanceOf(NetworkError);
      // With Math.random()=1 the sampled value equals the ceiling: 250, 500, 1000.
      expect(sleeps).toEqual([250, 500, 1000]);
    } finally {
      Math.random = original;
    }
  });
});

describe("retry policy — GET (reads)", () => {
  it("retries a 503 honoring Retry-After, then succeeds", async () => {
    let attempts = 0;
    const headers: Record<string, string>[] = [];
    const flakyFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
      if (attempts < 2) {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "down" },
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "0", // 0s so the test is instant but the path is exercised
            },
          },
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

describe("retry policy — orders.create", () => {
  it("retries on a network error (SAME key each attempt) then succeeds", async () => {
    let attempts = 0;
    const sentKeys: string[] = [];
    const flakyFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      const k = captureKey(init);
      if (k !== null) sentKeys.push(k);
      if (attempts < 2) throw new TypeError("connection reset");
      return new Response(JSON.stringify(V2_CREATE_OK), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SmscodeClient({
      token: "t",
      maxRetries: 2,
      fetch: flakyFetch,
    });

    const result = await client.orders.create(
      { catalog_product_id: 88 },
      { idempotencyKey: "dedup-replay_key" },
    );
    expect(attempts).toBe(2);
    // The SAME key was replayed on the retry — dedup-replay, at-most-once.
    expect(sentKeys).toEqual(["dedup-replay_key", "dedup-replay_key"]);
    expect(result.idempotencyKey).toBe("dedup-replay_key");
    expect(result.orders[0]!.id).toBe(90210);
  });

  it("does NOT retry a 422 (the create throws immediately)", async () => {
    let attempts = 0;
    const fetch422 = (async () => {
      attempts++;
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "bad" },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new SmscodeClient({
      token: "t",
      maxRetries: 3,
      fetch: fetch422,
    });

    const err = (await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: "k_422" })
      .catch((e: unknown) => e)) as SmscodeError;
    expect(err.code).toBe("VALIDATION_ERROR");
    // Exactly one attempt — 422 is never retried.
    expect(attempts).toBe(1);
  });

  it("does NOT retry a 409 IDEMPOTENCY_KEY_REUSED", async () => {
    let attempts = 0;
    const fetch409 = (async () => {
      attempts++;
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "IDEMPOTENCY_KEY_REUSED", message: "reused" },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new SmscodeClient({
      token: "t",
      maxRetries: 3,
      fetch: fetch409,
    });

    await client.orders
      .create({ catalog_product_id: 88 }, { idempotencyKey: "k_409" })
      .catch(() => undefined);
    expect(attempts).toBe(1);
  });
});

describe("retry policy — cancel/finish/resend are NOT auto-retried", () => {
  /**
   * The single-order state ops carry no idempotency key, so the client must NOT
   * blind-retry them even with maxRetries set. (They are read/write helpers added
   * in a later task; until then this guards the client's GET-only retry surface
   * does not silently retry these POSTs through `orders.create`'s path.)
   *
   * We assert the property at the transport layer: a POST to a cancel/finish/
   * resend path with NO idempotency key is attempted exactly once on a network
   * failure, because the client only retries when explicitly asked (these ops do
   * not opt into retry).
   */
  it("a POST cancel/finish/resend (retry:0) is attempted exactly once on failure", async () => {
    for (const path of [
      "/v2/orders/cancel",
      "/v2/orders/finish",
      "/v2/orders/resend",
    ]) {
      let attempts = 0;
      const calls: Captured[] = [];
      const client = new SmscodeClient({
        token: "t",
        maxRetries: 3,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          attempts++;
          calls.push({ url: String(input), init: init ?? {} });
          return Promise.reject(new TypeError("connection reset"));
        }) as typeof fetch,
      });

      // These ops are issued with retry:0 (no auto-retry, no idempotency key).
      await client
        .request("POST", path, { body: { order_id: 90210 }, retry: 0 })
        .catch(() => undefined);

      expect(attempts, `${path} must not auto-retry`).toBe(1);
      // No idempotency key is attached to these state ops.
      expect(captureKey(calls[0]!.init)).toBeNull();
    }
  });
});
