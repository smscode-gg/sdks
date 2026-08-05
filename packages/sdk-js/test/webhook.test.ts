/**
 * Webhook — `verifyWebhookSignature` + config methods + typed events.
 *
 * SECURITY surface. The platform signs every outbound delivery (when a
 * `webhook_secret` is set) with `X-Webhook-Signature: sha256=<hex>`, the
 * lowercase-hex HMAC-SHA256 of the **RAW request body** keyed by the secret.
 * {@link verifyWebhookSignature} must:
 *   - recompute over the EXACT received bytes (never a re-serialized JSON),
 *   - compare CONSTANT-TIME (no `===` / short-circuit on the digest), and
 *   - return `false` (never throw) on a malformed header, wrong secret, or
 *     tampered body.
 *
 * The known-answer vectors below are computed INDEPENDENTLY in-test with Node's
 * `crypto.createHmac`, so the assertions don't merely re-run the implementation.
 *
 * The config-method tests drive the REAL client path via an injected fetch mock,
 * mirroring `orders.mutations.test.ts`.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SmscodeClient } from "../src/client.js";
import {
  parseWebhookEvent,
  verifyWebhookSignature,
} from "../src/webhook.js";
import type { WebhookEvent } from "../src/webhook.js";

/** Independent reference HMAC: lowercase-hex SHA-256 over the raw bytes. */
function refHex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

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

// A realistic raw body — note the specific whitespace; re-serializing changes it.
const SECRET = "3f8a1c4e9b2d7a6f0c5e1d8b4a7f2e9c3b6d0a5f8e1c4b7d2a9f6e3c0b5d8a1f";
const RAW_BODY =
  '{"event":"order.otp_received","timestamp":"2026-05-11T09:05:00+00:00",'
  + '"data":{"order_id":90210,"otp_code":"123456"}}';

describe("verifyWebhookSignature — accept", () => {
  it("returns true for the correct sha256=<hex> over the raw string body", async () => {
    const header = `sha256=${refHex(SECRET, RAW_BODY)}`;
    expect(await verifyWebhookSignature(RAW_BODY, header, SECRET)).toBe(true);
  });

  it("returns true when the raw body is a Uint8Array of the SAME bytes", async () => {
    const header = `sha256=${refHex(SECRET, RAW_BODY)}`;
    const bytes = new TextEncoder().encode(RAW_BODY);
    expect(await verifyWebhookSignature(bytes, header, SECRET)).toBe(true);
  });

  it("accepts an uppercase-hex header (case-insensitive hex compare)", async () => {
    const header = `sha256=${refHex(SECRET, RAW_BODY).toUpperCase()}`;
    expect(await verifyWebhookSignature(RAW_BODY, header, SECRET)).toBe(true);
  });
});

describe("verifyWebhookSignature — reject", () => {
  it("returns false for a tampered body (same secret)", async () => {
    const header = `sha256=${refHex(SECRET, RAW_BODY)}`;
    const tampered = RAW_BODY.replace("90210", "90211");
    expect(await verifyWebhookSignature(tampered, header, SECRET)).toBe(false);
  });

  it("returns false for the wrong secret", async () => {
    const header = `sha256=${refHex(SECRET, RAW_BODY)}`;
    expect(
      await verifyWebhookSignature(RAW_BODY, header, "not-the-secret"),
    ).toBe(false);
  });

  it("returns false (not true) for a re-serialized-but-semantically-equal body — RAW bytes only", async () => {
    // A body WITH whitespace: the signature is over these exact bytes. A
    // semantically-equal compact re-serialization has different bytes → must NOT match.
    const rawWithWhitespace =
      '{\n  "event": "order.expired",\n  "data": { "order_id": 90210 }\n}';
    const compact = JSON.stringify(JSON.parse(rawWithWhitespace));
    expect(compact).not.toBe(rawWithWhitespace); // sanity: the bytes really differ
    const headerForRaw = `sha256=${refHex(SECRET, rawWithWhitespace)}`;
    // The original raw bytes verify…
    expect(
      await verifyWebhookSignature(rawWithWhitespace, headerForRaw, SECRET),
    ).toBe(true);
    // …but the re-serialized form (different bytes) does not.
    expect(await verifyWebhookSignature(compact, headerForRaw, SECRET)).toBe(
      false,
    );
  });

  it("returns false for a malformed header — missing sha256= prefix", async () => {
    expect(await verifyWebhookSignature(RAW_BODY, "nope", SECRET)).toBe(false);
    // A bare hex with no scheme is also malformed.
    expect(
      await verifyWebhookSignature(RAW_BODY, refHex(SECRET, RAW_BODY), SECRET),
    ).toBe(false);
  });

  it("returns false for a malformed header — empty digest (sha256=)", async () => {
    expect(await verifyWebhookSignature(RAW_BODY, "sha256=", SECRET)).toBe(false);
  });

  it("returns false for a malformed header — wrong-length hex", async () => {
    expect(await verifyWebhookSignature(RAW_BODY, "sha256=abcd", SECRET)).toBe(
      false,
    );
  });

  it("returns false for a malformed header — non-hex chars at the right length", async () => {
    // 64 chars but contains 'z' / 'g' (out of hex range).
    const notHex = "z".repeat(64);
    expect(
      await verifyWebhookSignature(RAW_BODY, `sha256=${notHex}`, SECRET),
    ).toBe(false);
  });

  it("returns false (never throws) for an empty / non-string header", async () => {
    expect(await verifyWebhookSignature(RAW_BODY, "", SECRET)).toBe(false);
    // @ts-expect-error — defensive: a non-string must not throw, just reject.
    expect(await verifyWebhookSignature(RAW_BODY, undefined, SECRET)).toBe(false);
  });
});

describe("verifyWebhookSignature — constant-time compare (structure)", () => {
  it("uses a constant-time, XOR-accumulating compare (no short-circuit ===)", async () => {
    // Timing itself is not unit-testable; assert by source structure that the
    // impl does NOT use a short-circuiting equality on the digest and DOES
    // XOR-accumulate across the full length.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/webhook.ts", import.meta.url), "utf8"),
    );
    // The constant-time routine XOR-accumulates a diff over the full length.
    expect(src).toMatch(/\^=|diff \|=|\|= \(/);
    // It must NOT compare the two digests with a short-circuiting `a === b`
    // string/typed-array equality (which leaks length/prefix via early-out).
    expect(src).not.toMatch(/return\s+\w*[Hh]ex\s*===|return\s+a\s*===\s*b/);
  });
});

describe("parseWebhookEvent — typed discriminated union", () => {
  it("narrows an order.expired payload by the `event` discriminant", () => {
    const raw = {
      event: "order.expired",
      timestamp: "2026-05-11T09:05:00+00:00",
      data: { order_id: 90210, product_id: 1024 },
    };
    const evt: WebhookEvent = parseWebhookEvent(JSON.stringify(raw));
    // Type narrowing: inside this branch `evt.event` is the literal.
    if (evt.event === "order.expired") {
      expect(evt.data.order_id).toBe(90210);
      expect(evt.event).toBe("order.expired");
    } else {
      throw new Error("expected order.expired to narrow");
    }
  });

  it("parses an order.otp_received payload and exposes otp_code", () => {
    const evt = parseWebhookEvent(RAW_BODY);
    if (evt.event === "order.otp_received") {
      expect(evt.data.otp_code).toBe("123456");
    } else {
      throw new Error("expected order.otp_received to narrow");
    }
  });

  it("preserves a no-code SMS as otp_code=null with otp_message", () => {
    const raw = {
      event: "order.otp_received",
      timestamp: "2026-05-11T09:05:00+00:00",
      data: {
        order_id: 90210,
        otp_code: null,
        otp_message: "Confirm your login: https://example.com/confirm",
        sms_revision: 1,
      },
    };
    const evt = parseWebhookEvent(JSON.stringify(raw));
    if (evt.event === "order.otp_received") {
      expect(evt.data.otp_code).toBeNull();
      expect(evt.data.otp_message).toBe(raw.data.otp_message);
      expect(evt.data.sms_revision).toBe(1);
    } else {
      throw new Error("expected order.otp_received to narrow");
    }
  });

  it("accepts the webhook.test event shape", () => {
    const raw = {
      event: "webhook.test",
      timestamp: "2026-05-11T09:05:00+00:00",
      data: { message: "This is a test webhook event from SMSCode." },
    };
    const evt = parseWebhookEvent(JSON.stringify(raw));
    if (evt.event === "webhook.test") {
      expect(evt.data.message).toContain("test webhook");
    } else {
      throw new Error("expected webhook.test to narrow");
    }
  });

  it("throws on a non-object / malformed payload", () => {
    expect(() => parseWebhookEvent("not json")).toThrow();
    expect(() => parseWebhookEvent("123")).toThrow();
    expect(() => parseWebhookEvent('{"event":42}')).toThrow();
  });
});

const CONFIG_OK = {
  success: true,
  data: {
    webhook_url: "https://example.com/hooks/smscode",
    webhook_secret: "a-shared-secret",
    webhook_disabled_at: null,
    webhook_disabled_reason: null,
    webhook_consecutive_failures: 0,
  },
};

describe("client.webhook config methods — /v2 default surface", () => {
  it("get() GETs /v2/webhook and returns the config", async () => {
    const sink: Captured[] = [];
    const client = new SmscodeClient({
      token: "tok",
      fetch: fakeFetch({ body: CONFIG_OK }, sink),
    });
    const cfg = await client.webhook.get();
    expect(sink[0]?.url).toMatch(/\/v2\/webhook$/);
    expect(sink[0]?.init.method).toBe("GET");
    expect(cfg.webhook_url).toBe("https://example.com/hooks/smscode");
    expect(cfg.webhook_consecutive_failures).toBe(0);
  });

  it("update() PATCHes /v2/webhook with the body", async () => {
    const sink: Captured[] = [];
    const client = new SmscodeClient({
      token: "tok",
      fetch: fakeFetch({ body: CONFIG_OK }, sink),
    });
    await client.webhook.update({ webhook_url: "https://x.example/hook" });
    expect(sink[0]?.url).toMatch(/\/v2\/webhook$/);
    expect(sink[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(sink[0]?.init.body))).toEqual({
      webhook_url: "https://x.example/hook",
    });
  });

  it("test() POSTs /v2/webhook/test and returns { status_code }", async () => {
    const sink: Captured[] = [];
    const client = new SmscodeClient({
      token: "tok",
      fetch: fakeFetch(
        { body: { success: true, data: { status_code: 200 } } },
        sink,
      ),
    });
    const res = await client.webhook.test();
    expect(sink[0]?.url).toMatch(/\/v2\/webhook\/test$/);
    expect(sink[0]?.init.method).toBe("POST");
    expect(res.status_code).toBe(200);
  });
});

describe("client.v1.webhook config methods — /v1 surface", () => {
  it("get() GETs /v1/webhook", async () => {
    const sink: Captured[] = [];
    const client = new SmscodeClient({
      token: "tok",
      fetch: fakeFetch({ body: CONFIG_OK }, sink),
    });
    await client.v1.webhook.get();
    expect(sink[0]?.url).toMatch(/\/v1\/webhook$/);
    expect(sink[0]?.init.method).toBe("GET");
  });

  it("update() PATCHes /v1/webhook and test() POSTs /v1/webhook/test", async () => {
    const sink: Captured[] = [];
    const client = new SmscodeClient({
      token: "tok",
      fetch: fakeFetch({ body: CONFIG_OK }, sink),
    });
    await client.v1.webhook.update({ webhook_secret: "" });
    expect(sink[0]?.url).toMatch(/\/v1\/webhook$/);
    expect(sink[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(sink[0]?.init.body))).toEqual({ webhook_secret: "" });

    const sink2: Captured[] = [];
    const client2 = new SmscodeClient({
      token: "tok",
      fetch: fakeFetch(
        { body: { success: true, data: { status_code: 502 } } },
        sink2,
      ),
    });
    const res = await client2.v1.webhook.test();
    expect(sink2[0]?.url).toMatch(/\/v1\/webhook\/test$/);
    expect(res.status_code).toBe(502);
  });
});
