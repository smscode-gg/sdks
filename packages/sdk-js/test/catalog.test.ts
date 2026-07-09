import { describe, expect, it } from "vitest";

import { SmscodeClient } from "../src/client.js";

/** A recorded request, captured by a fake fetch. */
interface Captured {
  url: string;
  init: RequestInit;
}

/**
 * Build a fake fetch that records the call and returns a fixed JSON response.
 * Exercises the REAL client path (URL build, query serialization, envelope
 * parse), not a mock of the resource.
 */
function fakeFetch(
  response: { status?: number; body?: unknown },
  sink?: Captured[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    sink?.push({ url: String(input), init: init ?? {} });
    const status = response.status ?? 200;
    const headers = new Headers({ "Content-Type": "application/json" });
    const text =
      response.body === undefined ? "" : JSON.stringify(response.body);
    return new Response(text, { status, headers });
  }) as typeof fetch;
}

const OPERATORS_BODY = {
  success: true,
  data: [
    { operator_id: null, code: "any", name: "Any", local_name: null },
    { operator_id: 42, code: "telkomsel", name: "Telkomsel", local_name: null },
  ],
};

describe("catalog.operators — #394C operator dimension", () => {
  it("v2 GETs /v2/catalog/operators with country_id + platform_id and returns the list (incl. `any`)", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: OPERATORS_BODY }, calls),
    });

    const ops = await client.catalog.operators({ country_id: 7, platform_id: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v2/catalog/operators");
    expect(calls[0]!.url).toContain("country_id=7");
    expect(calls[0]!.url).toContain("platform_id=1");
    // The synthesized `any` entry (null operator_id) leads, then real operators.
    expect(ops).toHaveLength(2);
    expect(ops[0]!.operator_id).toBeNull();
    expect(ops[0]!.code).toBe("any");
    expect(ops[1]!.operator_id).toBe(42);
    expect(ops[1]!.code).toBe("telkomsel");
    expect(ops[1]!.name).toBe("Telkomsel");
  });

  it("v1 GETs /v1/catalog/operators (legacy IDR surface, same shape)", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch({ body: OPERATORS_BODY }, calls),
    });

    const ops = await client.v1.catalog.operators({ country_id: 7, platform_id: 1 });

    expect(calls[0]!.url).toContain("/v1/catalog/operators");
    expect(calls[0]!.url).toContain("country_id=7");
    expect(calls[0]!.url).toContain("platform_id=1");
    expect(ops).toHaveLength(2);
    expect(ops[0]!.operator_id).toBeNull();
  });
});

describe("catalog.products — #394C operator_id coordinate", () => {
  it("forwards operator_id as a query param on the v1 products list", async () => {
    const calls: Captured[] = [];
    const client = new SmscodeClient({
      token: "t",
      fetch: fakeFetch(
        {
          body: {
            success: true,
            data: [
              {
                id: 10,
                available: 5,
                price: 750000,
                active: true,
                operator_id: 42,
                operator_name: "Telkomsel",
              },
            ],
            meta: { page: 1, limit: 1000, count: 1 },
          },
        },
        calls,
      ),
    });

    const page = await client.v1.catalog.products({
      country_id: 7,
      platform_id: 1,
      operator_id: 42,
    });

    expect(calls[0]!.url).toContain("operator_id=42");
    // The decoded product row carries the operator fields verbatim.
    expect(page.products[0]!.operator_id).toBe(42);
    expect(page.products[0]!.operator_name).toBe("Telkomsel");
  });

  it("omits operator_id from the query when not provided (the `any` coordinate)", async () => {
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

    await client.v1.catalog.products({ country_id: 7, platform_id: 1 });

    expect(calls[0]!.url).not.toContain("operator_id");
  });
});
