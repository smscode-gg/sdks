/**
 * Webhook signature verification + typed events.
 *
 * The SMSCode platform signs every outbound delivery (when a `webhook_secret` is
 * configured) with an `X-Webhook-Signature: sha256=<hex>` header — the
 * lowercase-hex **HMAC-SHA256 of the RAW request body**, keyed by your secret.
 *
 * {@link verifyWebhookSignature} recomputes that HMAC over the EXACT received
 * bytes and compares it to the header's digest in **constant time**, so:
 *   - it operates on the raw bytes you received (NEVER a re-parsed/re-serialized
 *     JSON — re-serializing changes the bytes and would always fail to match);
 *   - the compare XOR-accumulates a diff over the full digest length (no `===`
 *     and no short-circuiting equality, which would leak length/prefix via an
 *     early return);
 *   - a malformed header, wrong secret, or tampered body returns `false` — it
 *     never throws on a bad header.
 *
 * It uses the Web Crypto API (`crypto.subtle`), available on Node 18+, Bun, Deno,
 * and browsers — so the SDK stays isomorphic and zero-dependency (no Node
 * `crypto` import).
 */
import type { components } from "./types.gen.js";

/**
 * A signed webhook event the platform POSTs to your `webhook_url`.
 *
 * A discriminated union on the `event` field: narrow on `event` to access the
 * branch's `data`. Order transitions carry a {@link WebhookEventData} snapshot;
 * the `webhook.test` event (from `POST /webhook/test`) carries a fixed marker.
 *
 * @example
 * ```ts
 * const evt = parseWebhookEvent(rawBody);
 * if (evt.event === "order.otp_received") {
 *   console.log(evt.data.otp_code);
 * }
 * ```
 */
export type WebhookEvent =
  | components["schemas"]["WebhookEvent"]
  | components["schemas"]["WebhookTestEvent"];

/** The order snapshot carried by an order webhook event. */
export type WebhookEventData = components["schemas"]["WebhookEventData"];

/** The set of valid `event` discriminants. */
const WEBHOOK_EVENTS: ReadonlySet<string> = new Set([
  "order.otp_received",
  "order.completed",
  "order.expired",
  "order.canceled",
  "webhook.test",
]);

/** The `sha256=<hex>` outbound signature scheme. */
const SIGNATURE_PREFIX = "sha256=";
/** SHA-256 digest length in bytes (→ 64 lowercase-hex chars). */
const SHA256_BYTES = 32;

/** Shared encoder — reused so a string body is encoded to bytes exactly once. */
const ENCODER = new TextEncoder();

/**
 * Coerce a string|Uint8Array body to raw bytes over a plain `ArrayBuffer`.
 *
 * A string is encoded to UTF-8 bytes once. A `Uint8Array` is normalized to a
 * fresh `ArrayBuffer`-backed copy — both so the bytes are never mutated under us
 * and so the typed array satisfies Web Crypto's `BufferSource` (`ArrayBuffer`,
 * not a possibly-`SharedArrayBuffer`-backed view).
 */
function toBytes(rawBody: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof rawBody === "string") return ENCODER.encode(rawBody);
  const copy = new Uint8Array(rawBody.length);
  copy.set(rawBody);
  return copy;
}

/**
 * Decode a lowercase/uppercase hex string to bytes.
 *
 * Returns `null` (rather than throwing) if the input is not strictly hex or has
 * an odd length — a malformed header must reject, not throw.
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexNibble(hex.charCodeAt(i * 2));
    const lo = hexNibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Map a hex char code to its nibble value, or `-1` if not a hex digit. */
function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}

/**
 * Constant-time byte-array equality.
 *
 * XOR-accumulates a difference across the FULL length and only then reduces to a
 * boolean, so it does not short-circuit on the first differing byte (which would
 * leak a timing signal). Unequal lengths return `false` immediately — a length
 * mismatch is not secret here (both operands are fixed 32-byte SHA-256 digests).
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // `!` is safe: i is always in-range under noUncheckedIndexedAccess.
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/** Compute the HMAC-SHA256 of `bytes` keyed by `secret`, returning the raw digest. */
async function hmacSha256(
  secret: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, bytes);
  return new Uint8Array(sig);
}

/**
 * Verify an `X-Webhook-Signature: sha256=<hex>` header against the raw body.
 *
 * @param rawBody  The EXACT bytes you received (a `string` is encoded to UTF-8
 *   bytes once). Do NOT pass a re-parsed/re-serialized JSON — re-serializing
 *   changes the bytes and the signature will not match.
 * @param signatureHeader  The full header value, e.g. `sha256=ab12…`. Hex is
 *   compared case-insensitively. A missing `sha256=` prefix, wrong length, or
 *   non-hex digest returns `false` (this function never throws on a bad header).
 * @param secret  Your `webhook_secret`.
 * @returns `true` only if the recomputed HMAC matches the header digest
 *   (constant-time); `false` for a wrong secret, tampered body, or malformed header.
 */
export async function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  // 1) Parse the header — reject (don't throw) anything that isn't `sha256=<hex>`.
  if (typeof signatureHeader !== "string") return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = hexToBytes(signatureHeader.slice(SIGNATURE_PREFIX.length));
  // A well-formed signature is exactly a 32-byte (64-hex) SHA-256 digest.
  if (provided === null || provided.length !== SHA256_BYTES) return false;

  // 2) Recompute the HMAC over the RAW bytes (string encoded to UTF-8 once).
  const expected = await hmacSha256(secret, toBytes(rawBody));

  // 3) Constant-time compare of the decoded digest bytes.
  return constantTimeEqual(expected, provided);
}

/** A minimally-shaped candidate before discriminant validation. */
type EventCandidate = { event?: unknown };

/**
 * Parse + validate a raw webhook body into a typed {@link WebhookEvent}.
 *
 * Accepts a JSON string or an already-parsed object. Validates only the `event`
 * discriminant (one of the known event types) — enough to narrow the union; the
 * branch payloads stay as typed by the contract. Throws a `TypeError` if the
 * input is not an object or carries an unknown/absent `event`.
 *
 * Verify the signature with {@link verifyWebhookSignature} BEFORE trusting a
 * parsed event.
 */
export function parseWebhookEvent(raw: string | unknown): WebhookEvent {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new TypeError("Webhook payload is not valid JSON.");
    }
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Webhook payload is not a JSON object.");
  }
  const event = (value as EventCandidate).event;
  if (typeof event !== "string" || !WEBHOOK_EVENTS.has(event)) {
    throw new TypeError(
      `Webhook payload has an unknown event type: ${JSON.stringify(event)}.`,
    );
  }
  return value as WebhookEvent;
}

/** A type guard: `true` if `value` is a recognized {@link WebhookEvent}. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = (value as EventCandidate).event;
  return typeof event === "string" && WEBHOOK_EVENTS.has(event);
}
