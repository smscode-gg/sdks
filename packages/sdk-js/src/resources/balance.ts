/**
 * Balance read resource.
 *
 * - {@link V2BalanceResource} (`client.balance.get`) projects the IDR ledger
 *   balance to a USD {@link Money} object and carries the FX receipt.
 * - {@link V1BalanceResource} (`client.v1.balance.get`) returns the canonical
 *   IDR balance verbatim (a plain `number`).
 */
import { requireFx } from "../internal/decode.js";
import { parseMoney } from "../money.js";
import type { Money } from "../money.js";
import type { RequestFn } from "./catalog.js";
import type { components } from "../types.gen.js";

type V1Balance = components["schemas"]["V1Balance"];
type V2Balance = components["schemas"]["V2Balance"];
type V2Fx = components["schemas"]["V2Fx"];

/** The decoded `/v2` balance — a USD {@link Money} plus the FX receipt. */
export interface BalanceV2 {
  balance: Money;
  fx: V2Fx;
}

/** The `/v2` balance surface (USD-projected). */
export class V2BalanceResource {
  constructor(private readonly request: RequestFn) {}

  /** Fetch the authenticated account balance, USD-projected, with an FX receipt. */
  async get(): Promise<BalanceV2> {
    const result = await this.request<V2Balance>("GET", "/v2/balance");
    // Validate the envelope shape with TYPED errors (consistent with orders):
    // `requireFx` throws `INVALID_RESPONSE` on a missing FX receipt, and
    // `parseMoney` throws `INVALID_MONEY` on a missing/malformed `balance` —
    // never a raw `TypeError`. This is a read; no idempotency key is involved.
    const fx = requireFx(result);
    const data = result.data as V2Balance;
    return { balance: parseMoney(data.balance), fx };
  }
}

/** The `/v1` balance surface (canonical IDR). */
export class V1BalanceResource {
  constructor(private readonly request: RequestFn) {}

  /** Fetch the authenticated account balance in IDR minor units. */
  async get(): Promise<V1Balance> {
    const { data } = await this.request<V1Balance>("GET", "/v1/balance");
    return data as V1Balance;
  }
}
