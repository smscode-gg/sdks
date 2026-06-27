/**
 * `/v2` money decoding.
 *
 * Every `/v2` money value is a {@link V2Money}: a USD display `amount` (a decimal
 * string, never a float) carried alongside the canonical IDR ledger truth
 * (`canonical_amount`, an integer in IDR minor units). {@link parseMoney}
 * normalizes that wire shape into a stable, camelCase {@link Money} object.
 *
 * **Zero-dependency, standard `JSON.parse`.** The client parses the envelope with
 * the built-in `JSON.parse`, so `canonical_amount` arrives already as a JS
 * number. IDR values are domain-bounded far below 2^53 (the JS safe-integer
 * ceiling), so this is lossless for every real value. This module does NOT add a
 * lossless/BigInt JSON parser, and it does NOT claim to preserve a token that was
 * already out of range upstream — `JSON.parse` would have rounded such a token
 * before this code ever saw it.
 */
import { SmscodeError } from "./errors.js";
import type { components } from "./types.gen.js";

/** The raw `/v2` money wire shape (from the OpenAPI contract). */
export type V2Money = components["schemas"]["V2Money"];

/** A decoded `/v2` money value. */
export interface Money {
  /**
   * The USD amount as a decimal string, preserved verbatim from the wire (never
   * coerced to a float — that would lose precision). Balance/total values carry
   * 2 decimal places; product-derived prices carry 4.
   */
  amount: string;
  /** Always `"USD"` for a `/v2` money value. */
  currency: "USD";
  /**
   * The canonical ledger amount in **IDR** minor units, as a JS number. IDR
   * values sit far below the safe-integer ceiling, so this is exact.
   */
  canonicalAmount: number;
  /**
   * `String(canonicalAmount)` — a string convenience for `BigInt(...)` or
   * display. It is NOT beyond-safe-integer preservation: it is exactly the
   * string form of the already-parsed number.
   */
  canonicalAmountRaw: string;
  /** Always `"IDR"` — the canonical ledger currency. */
  canonicalCurrency: "IDR";
}

/**
 * Decode a `/v2` money object.
 *
 * Keeps `amount` as the USD display string, exposes the canonical IDR integer as
 * both a number (`canonicalAmount`) and its string form (`canonicalAmountRaw`).
 *
 * @throws {SmscodeError} (code `INVALID_MONEY`) if the money value is absent or
 *   not an object (e.g. a malformed 2xx envelope omitted the field). Without this
 *   guard, dereferencing `canonical_amount` on `undefined` would throw a raw
 *   `TypeError` rather than the SDK's typed error.
 * @throws {SmscodeError} (code `INVALID_MONEY`) if `canonical_amount` is not a
 *   safe integer. This defensive guard documents the IDR domain bound (IDR minor
 *   units sit far below 2^53) and never fires for a real value; if it ever does,
 *   the upstream value was already corrupted by a standard JSON parse and must
 *   not be trusted as a money amount.
 */
export function parseMoney(m: V2Money): Money {
  // The static type says `m` is always present, but a malformed 2xx envelope can
  // omit a money field at runtime. Guard with a TYPED error so a missing/non-object
  // value never dereferences into a raw `TypeError` (SDK-consistent errors).
  if (m === null || typeof m !== "object") {
    throw new SmscodeError(
      "INVALID_MONEY",
      "A money value is missing or malformed in the response; it cannot be decoded.",
    );
  }
  const canonicalAmount = m.canonical_amount;
  if (!Number.isSafeInteger(canonicalAmount)) {
    throw new SmscodeError(
      "INVALID_MONEY",
      `Canonical money amount ${String(
        canonicalAmount,
      )} is not a safe integer; the IDR ledger value is out of the supported range.`,
      { details: { canonicalAmount } },
    );
  }
  return {
    amount: m.amount,
    currency: m.currency,
    canonicalAmount,
    canonicalAmountRaw: String(canonicalAmount),
    canonicalCurrency: m.canonical_currency,
  };
}
