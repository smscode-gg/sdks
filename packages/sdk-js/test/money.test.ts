import { describe, expect, it } from "vitest";

import { parseMoney } from "../src/money.js";
import { SmscodeError } from "../src/errors.js";

describe("parseMoney", () => {
  it("keeps `amount` as the USD display string and decodes the canonical IDR integer", () => {
    const money = parseMoney({
      amount: "12.50",
      currency: "USD",
      canonical_amount: 200000,
      canonical_currency: "IDR",
    });

    expect(money).toEqual({
      amount: "12.50",
      currency: "USD",
      canonicalAmount: 200000,
      canonicalAmountRaw: "200000",
      canonicalCurrency: "IDR",
    });
  });

  it("keeps `amount` as a string (never coerced to a float)", () => {
    const money = parseMoney({
      amount: "78.1300",
      currency: "USD",
      canonical_amount: 1250000,
      canonical_currency: "IDR",
    });

    // The USD amount is preserved verbatim, trailing zeros and all.
    expect(money.amount).toBe("78.1300");
    expect(typeof money.amount).toBe("string");
  });

  it("exposes `canonicalAmount` as a JS number and `canonicalAmountRaw` as its string form", () => {
    const money = parseMoney({
      amount: "0.06",
      currency: "USD",
      canonical_amount: 1000,
      canonical_currency: "IDR",
    });

    expect(typeof money.canonicalAmount).toBe("number");
    expect(money.canonicalAmount).toBe(1000);
    // canonicalAmountRaw is purely a string convenience — exactly String(canonicalAmount).
    expect(money.canonicalAmountRaw).toBe(String(money.canonicalAmount));
    // BigInt round-trips from the raw string (the documented use).
    expect(BigInt(money.canonicalAmountRaw)).toBe(1000n);
  });

  it("handles a zero canonical amount", () => {
    const money = parseMoney({
      amount: "0.00",
      currency: "USD",
      canonical_amount: 0,
      canonical_currency: "IDR",
    });

    expect(money.canonicalAmount).toBe(0);
    expect(money.canonicalAmountRaw).toBe("0");
  });

  it("trips the defensive safe-integer assertion for a synthetic out-of-range canonical amount", () => {
    // Number.MAX_SAFE_INTEGER + 1 is not a safe integer. Real IDR values sit far
    // below 2^53, so this guard never fires in production — it documents the bound.
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(Number.isSafeInteger(unsafe)).toBe(false);

    expect(() =>
      parseMoney({
        amount: "999999999999999",
        currency: "USD",
        canonical_amount: unsafe,
        canonical_currency: "IDR",
      }),
    ).toThrow(SmscodeError);
  });

  it("the safe-integer error carries a clear message about the canonical amount", () => {
    let thrown: unknown;
    try {
      parseMoney({
        amount: "x",
        currency: "USD",
        canonical_amount: Number.MAX_SAFE_INTEGER + 2,
        canonical_currency: "IDR",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SmscodeError);
    expect((thrown as Error).message).toMatch(/canonical/i);
  });
});
