/**
 * Order resources — reads (get, list, active) and the money-path create.
 *
 * - {@link V2OrdersResource} (`client.orders.*`) projects each order's `amount`
 *   to a USD {@link Money} object and carries the FX receipt. Its `create`
 *   `max_price` is a USD **decimal string**.
 * - {@link V1OrdersResource} (`client.v1.orders.*`) returns canonical IDR shapes
 *   verbatim — `amount` is a plain IDR `number`, and `create` `max_price` is an
 *   IDR **integer**.
 *
 * **Create is the money-safety path.** Both surfaces resolve an idempotency key
 * up front (see {@link resolveKey}), send it on the `idempotency-key` header,
 * retry only transient failures with the SAME key (never 422/409), attach the key
 * to the success result, and stamp the SAME key onto EVERY thrown error so a
 * caller can always retry safely.
 *
 * `active()` is money-free on both surfaces (status + OTP fields only), so it is
 * shared between the two.
 */
import { SmscodeError } from "../errors.js";
import { requireFx } from "../internal/decode.js";
import { resolveKey } from "../idempotency.js";
import { parseMoney } from "../money.js";
import type { Money } from "../money.js";
import { waitForOtp } from "../wait.js";
import type { OtpResult, WaitForOtpOptions } from "../wait.js";
import type { ApiResult, QueryValue } from "../client.js";
import type { components } from "../types.gen.js";

/** The full request surface a resource needs (reads + writes). */
export type RequestFn = <T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options?: {
    query?: Record<string, QueryValue>;
    body?: unknown;
    headers?: Record<string, string>;
    retry?: number;
    signal?: AbortSignal;
  },
) => Promise<ApiResult<T>>;

type V1OrderSummary = components["schemas"]["V1OrderSummary"];
type V2OrderSummary = components["schemas"]["V2OrderSummary"];
type V1OrderStatus = components["schemas"]["V1OrderStatus"];
type V2Fx = components["schemas"]["V2Fx"];
type V1CreateOrderItem = components["schemas"]["V1CreateOrderItem"];
type V2CreateOrderItem = components["schemas"]["V2CreateOrderItem"];
type V1CreateOrderResult = components["schemas"]["V1CreateOrderResult"];
type V2CreateOrderResult = components["schemas"]["V2CreateOrderResult"];
type V1CancelOrderResult = components["schemas"]["V1CancelOrderResult"];
type V2CancelResult = components["schemas"]["V2CancelResult"];
type V1FinishOrderResult = components["schemas"]["V1FinishOrderResult"];
type V1ResendResult = components["schemas"]["V1ResendResult"];

/** Query parameters for the order listing. */
export interface OrdersListParams {
  /** Max orders per page (server-clamped 1–100; default 20). */
  limit?: number;
  /** Number of orders to skip (default 0). */
  offset?: number;
  /** Filter by order status (case-insensitive). */
  status?: components["parameters"]["OrderStatusQuery"];
}

/** Per-create options shared by both surfaces. */
export interface CreateOrderOptions {
  /**
   * The idempotency key for this create. If omitted, a v4 UUID is generated. A
   * provided key is validated up front (`^[A-Za-z0-9_-]{1,128}$`) and a
   * {@link ValidationError} is thrown **before any request** on a miss.
   */
  idempotencyKey?: string;
  /** An external abort signal for the request. */
  signal?: AbortSignal;
}

/**
 * Per-reactivate options for the `/v2` surface — {@link CreateOrderOptions}
 * (money-safety idempotency key + abort signal) plus an optional USD-decimal cost
 * CEILING that mirrors the `/v2` create `max_price` unit.
 */
export interface ReactivateOrderOptionsV2 extends CreateOrderOptions {
  /** USD-decimal string cost CEILING (e.g. `"0.75"`); refuse if the cost exceeds it. */
  max_price?: string;
}

/**
 * Per-reactivate options for the `/v1` surface — {@link CreateOrderOptions}
 * plus an optional IDR-integer cost CEILING that mirrors the `/v1` create
 * `max_price` unit.
 */
export interface ReactivateOrderOptionsV1 extends CreateOrderOptions {
  /** IDR-integer cost CEILING (minor units); refuse if the reactivation cost exceeds it. */
  max_price?: number;
}

/**
 * `/v1` create request — the generated contract shape with `quantity` made
 * OPTIONAL.
 *
 * The API treats `quantity` as optional (`#[serde(default)]` → defaults to `1`,
 * and the OpenAPI contract does not list it in `required`), but the code-gen
 * emits it as required (`openapi-typescript` ignores `default` for requiredness).
 * The SDK therefore optionalizes it at the create surface so `create({ ... })`
 * (no `quantity`) compiles and orders a single number — without hand-editing the
 * generated `types.gen.ts`. Omitting `quantity` sends no field; the server fills
 * the default.
 */
export type V1CreateOrderRequest = Omit<
  components["schemas"]["V1CreateOrderRequest"],
  "quantity"
> & {
  /** How many numbers to order in one request (1–100). Omit for a single number. */
  quantity?: number;
};

/**
 * `/v2` create request — the generated contract shape with `quantity` made
 * OPTIONAL (see {@link V1CreateOrderRequest} for the rationale).
 */
export type V2CreateOrderRequest = Omit<
  components["schemas"]["V2CreateOrderRequest"],
  "quantity"
> & {
  /** How many numbers to order in one request (1–100). Omit for a single number. */
  quantity?: number;
};

/** A decoded `/v2` order — identical to {@link V2OrderSummary} but `amount` is a {@link Money}, plus the FX receipt. */
export interface OrderV2 extends Omit<V2OrderSummary, "amount"> {
  amount: Money;
  /** The FX receipt for this response (the rate every money value was projected at). */
  fx: V2Fx;
}

/** A `/v2` order list — decoded orders plus the shared FX receipt. */
export interface OrdersListV2 {
  orders: Array<Omit<V2OrderSummary, "amount"> & { amount: Money }>;
  fx: V2Fx;
}

/** One created `/v2` order — `amount` projected to USD {@link Money}. */
export type CreatedOrderV2 = Omit<V2CreateOrderItem, "amount"> & {
  amount: Money;
};

/** The decoded `/v2` create result, with the resolved idempotency key + FX receipt. */
export interface CreateOrderResultV2
  extends Omit<V2CreateOrderResult, "orders"> {
  orders: CreatedOrderV2[];
  /** The FX receipt the response was projected at. */
  fx: V2Fx;
  /** The idempotency key used for this create (provided or generated). */
  idempotencyKey: string;
}

/** The `/v1` create result, with the resolved idempotency key (IDR amounts). */
export interface CreateOrderResultV1 extends V1CreateOrderResult {
  /** The idempotency key used for this create (provided or generated). */
  idempotencyKey: string;
}

/**
 * The decoded `/v2` cancel result — both money fields projected to USD
 * {@link Money} (at the contract's intentional mixed precision: `refund_amount`
 * 4-decimal, `new_balance` 2-decimal) plus the FX receipt.
 */
export interface CancelResultV2 extends Omit<V2CancelResult, "refund_amount" | "new_balance"> {
  refund_amount: Money;
  new_balance: Money;
  /** The FX receipt the response was projected at. */
  fx: V2Fx;
}

/**
 * The decoded `/v2` reactivate-options preview — the reactivation cost
 * projected to a USD {@link Money} object plus the FX receipt. A read-only quote
 * (NO idempotency key); mirrors the order-amount precision (4dp, price-derived).
 */
export interface ReactivateOptionsV2 {
  /** The reactivation cost right now, projected to a USD {@link Money}. */
  cost: Money;
  /** The FX receipt the cost was projected at. */
  fx: V2Fx;
}

/**
 * The `/v1` reactivate-options preview — the reactivation cost in IDR minor
 * units (integer). A read-only quote (NO idempotency key).
 */
export interface ReactivateOptionsV1 {
  /** The reactivation cost right now, in IDR minor units. */
  cost: number;
}

/**
 * Issue a create with money-safety idempotency.
 *
 * Resolves the key up front (throwing on an invalid provided key **before** any
 * request), sends it on the `idempotency-key` header, lets the client retry only
 * transient failures with the SAME key, and stamps the SAME key onto every thrown
 * error.
 *
 * **The stamping boundary spans the FULL create pipeline — both the request AND
 * the success decode.** The server may have already placed/debited the order by
 * the time the success envelope is decoded, so a decode failure
 * ({@link parseMoney}'s `INVALID_MONEY`, or a malformed-envelope error from
 * `decode` itself) is exactly as money-sensitive as a transport failure: it MUST
 * carry the key so the caller can replay it (a fresh key would risk a double
 * charge). The caller's `decode` therefore runs INSIDE the try/catch, and any
 * {@link SmscodeError} it throws is stamped with the resolved key.
 *
 * Decode is expected to validate the success envelope and throw a TYPED
 * {@link SmscodeError} on a malformed shape (see {@link decodeV2CreateResult}).
 * As a backstop, a catch-all wraps any NON-{@link SmscodeError} the decode might
 * still throw (e.g. a raw `TypeError` from `parseMoney` on an order item missing
 * `amount`) into a TYPED, STAMPED `INVALID_RESPONSE` — so NO create error can
 * ever escape this boundary unstamped.
 */
async function createWithIdempotency<R>(
  request: RequestFn,
  path: string,
  body: unknown,
  opts: CreateOrderOptions | undefined,
  decode: (result: ApiResult<unknown>, key: string) => R,
): Promise<{ value: R; key: string }> {
  // 1) Resolve the key FIRST — an invalid provided key throws here, before any
  //    request is issued (no money operation is attempted under a bad key).
  const key = resolveKey(opts?.idempotencyKey);

  try {
    // 2) Issue the create with the key on the header. The client retries only
    //    transient failures (network/429/503) — never 422/409 — replaying the
    //    SAME key each attempt (server-side dedup → at-most-once).
    const options: {
      body: unknown;
      headers: Record<string, string>;
      signal?: AbortSignal;
    } = {
      body,
      headers: { "idempotency-key": key },
    };
    if (opts?.signal !== undefined) options.signal = opts.signal;
    const result = await request<unknown>("POST", path, options);
    // 3) Decode the SUCCESS envelope INSIDE the boundary. A money/shape failure
    //    here is post-success (order may be placed) — it must be stamped too.
    return { value: decode(result, key), key };
  } catch (err) {
    // 4) Stamp the SAME key onto ANY thrown error (typed API errors, network,
    //    timeout, abort, the final retry-exhaustion throw, AND a typed decode
    //    error) so the caller can always retry with it.
    if (err instanceof SmscodeError) {
      throw err.withIdempotencyKey(key);
    }
    // 5) Catch-all guardrail: a NON-`SmscodeError` reaching here is a decode/shape
    //    failure (e.g. `parseMoney` on an order item missing `amount` dereferences
    //    a raw `TypeError` BEFORE its typed `INVALID_MONEY` can fire). Request
    //    errors are already `SmscodeError` (the client's `mapError`), so anything
    //    else is a malformed success envelope. Wrap it as a TYPED, STAMPED
    //    `INVALID_RESPONSE` (preserving the original via `cause`) so NO create
    //    error EVER escapes unstamped — the 200 means the order may be
    //    placed/debited, and the caller must be able to replay the SAME key.
    throw new SmscodeError(
      "INVALID_RESPONSE",
      "Failed to decode the create response.",
      { cause: err },
    ).withIdempotencyKey(key);
  }
}

/**
 * Issue a single-order state mutation (cancel / finish / resend).
 *
 * These ops carry NO idempotency key, so a blind retry could double-apply a side
 * effect — the request is therefore issued with retry DISABLED (`retry: 0`). The
 * body is `{ id }` (the contract's `V1OrderIdRequest`, shared by `/v1` and `/v2`).
 */
async function mutateOrder<T>(
  request: RequestFn,
  path: string,
  orderId: number,
): Promise<ApiResult<T>> {
  return request<T>("POST", path, { body: { id: orderId }, retry: 0 });
}

/**
 * Poll the FX-free `/v1/orders/{id}` status for {@link waitForOtp}.
 *
 * Always the `/v1` path (a money-free read, never an FX projection) so a `/v2` FX
 * `503` cannot break OTP-waiting. Shared by both surfaces' `waitForOtp`.
 */
function pollV1Order(
  request: RequestFn,
  orderId: number,
): Promise<V1OrderSummary> {
  return request<V1OrderSummary>("GET", `/v1/orders/${orderId}`).then(
    (r) => r.data as V1OrderSummary,
  );
}

/**
 * Decode a `/v2` create success envelope into a {@link CreateOrderResultV2}.
 *
 * Validates the envelope shape (FX receipt present via {@link requireFx}) and
 * projects each order's `amount` to a USD {@link Money} (via {@link parseMoney},
 * which throws a typed `INVALID_MONEY` on an unsafe canonical amount). Runs INSIDE
 * the create's idempotency-stamp boundary, so any failure here is stamped.
 */
function decodeV2CreateResult(
  result: ApiResult<unknown>,
  key: string,
): CreateOrderResultV2 {
  const fx = requireFx(result);
  const data = result.data as V2CreateOrderResult;
  const orders: CreatedOrderV2[] = (data.orders ?? []).map((o) => ({
    ...o,
    amount: parseMoney(o.amount),
  }));
  return { ...data, orders, fx, idempotencyKey: key };
}

/**
 * Decode a `/v1` create/reactivate success envelope into a {@link CreateOrderResultV1}.
 *
 * `/v1` amounts are plain IDR numbers (no Money projection), so this is trivial —
 * but it still validates the envelope shape. `/v1` has no money projection (no
 * `parseMoney`/`requireFx` to fail on a bad shape), so without this a malformed
 * 2xx (absent/empty `data`) would spread to a SILENT no-op and return a broken
 * `{ idempotencyKey }`. A 200 may mean the order is placed/debited, so throw a
 * TYPED `INVALID_RESPONSE` — the create boundary stamps it with the key (mirrors
 * the `/v2` envelope guards). Shared by `create` and `reactivate` (both return the
 * same `CreateOrderResult` shape).
 */
function decodeV1CreateResult(
  result: ApiResult<unknown>,
  key: string,
): CreateOrderResultV1 {
  const data = result.data;
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { orders?: unknown }).orders)
  ) {
    throw new SmscodeError(
      "INVALID_RESPONSE",
      "The /v1 response is missing its orders array; the result cannot be trusted.",
      { httpStatus: result.status },
    );
  }
  return {
    ...(data as V1CreateOrderResult),
    idempotencyKey: key,
  };
}

/** The `/v2` orders surface (USD-projected). */
export class V2OrdersResource {
  constructor(private readonly request: RequestFn) {}

  /**
   * Create (rent) one or more numbers, USD-native (money-safety idempotency).
   *
   * `req.max_price` is a USD **decimal string** (e.g. `"0.50"`), floor-converted
   * to IDR at the server boundary. Each created order's `amount` is projected to
   * a USD {@link Money}, and the result carries the FX receipt plus the resolved
   * `idempotencyKey`.
   */
  async create(
    req: V2CreateOrderRequest,
    opts?: CreateOrderOptions,
  ): Promise<CreateOrderResultV2> {
    // The decode (FX-receipt validation + per-order Money projection) runs INSIDE
    // the idempotency-stamp boundary, so a post-success `INVALID_RESPONSE` /
    // `INVALID_MONEY` throw still carries the resolved key (money-safety).
    const { value } = await createWithIdempotency(
      this.request,
      "/v2/orders/create",
      req,
      opts,
      decodeV2CreateResult,
    );
    return value;
  }

  /** Fetch one order by id, USD-projected, with the FX receipt. */
  async get(id: number): Promise<OrderV2> {
    const result = await this.request<V2OrderSummary>(
      "GET",
      `/v2/orders/${id}`,
    );
    // Validate the envelope shape with TYPED errors (consistent with create):
    // `requireFx` throws `INVALID_RESPONSE` on a missing FX receipt, and
    // `parseMoney` throws `INVALID_MONEY` on a missing/malformed `amount` —
    // never a raw `TypeError`.
    const fx = requireFx(result);
    const data = result.data as V2OrderSummary;
    return { ...data, amount: parseMoney(data.amount), fx };
  }

  /** List orders, USD-projected, with the FX receipt. */
  async list(params: OrdersListParams = {}): Promise<OrdersListV2> {
    const result = await this.request<V2OrderSummary[]>("GET", "/v2/orders", {
      query: {
        limit: params.limit,
        offset: params.offset,
        status: params.status,
      },
    });
    // Validate the envelope shape with TYPED errors (consistent with create):
    // `requireFx` throws `INVALID_RESPONSE` on a missing FX receipt, and
    // `parseMoney` throws `INVALID_MONEY` on a missing/malformed per-order
    // `amount` — never a raw `TypeError`.
    const fx = requireFx(result);
    const orders = (result.data ?? []).map((o) => ({
      ...o,
      amount: parseMoney(o.amount),
    }));
    return { orders, fx };
  }

  /** List active orders (money-free: status + OTP fields only). */
  async active(): Promise<V1OrderStatus[]> {
    const { data } = await this.request<V1OrderStatus[]>(
      "GET",
      "/v2/orders/active",
    );
    return data ?? [];
  }

  /**
   * Cancel an order (and refund it), USD-projected.
   *
   * Not auto-retried (no idempotency key). Both money fields are decoded to USD
   * {@link Money} objects and the FX receipt is attached.
   */
  async cancel(orderId: number): Promise<CancelResultV2> {
    const result = await mutateOrder<V2CancelResult>(
      this.request,
      "/v2/orders/cancel",
      orderId,
    );
    // Validate the envelope shape with TYPED errors (consistent with create):
    // `requireFx` throws `INVALID_RESPONSE` on a missing FX receipt, and
    // `parseMoney` throws `INVALID_MONEY` on a missing/malformed money field —
    // never a raw `TypeError`. Cancel carries NO idempotency key, so there is no
    // key to stamp; this is read-path robustness, not a double-charge guard.
    const fx = requireFx(result);
    const data = result.data;
    return {
      ...data,
      refund_amount: parseMoney(data.refund_amount),
      new_balance: parseMoney(data.new_balance),
      fx,
    };
  }

  /** Mark an order finished (money-free). Not auto-retried (no idempotency key). */
  async finish(orderId: number): Promise<V1FinishOrderResult> {
    const { data } = await mutateOrder<V1FinishOrderResult>(
      this.request,
      "/v2/orders/finish",
      orderId,
    );
    return data;
  }

  /** Ask the provider to resend the SMS (money-free). Not auto-retried (no idempotency key). */
  async resend(orderId: number): Promise<V1ResendResult> {
    const { data } = await mutateOrder<V1ResendResult>(
      this.request,
      "/v2/orders/resend",
      orderId,
    );
    return data;
  }

  /**
   * Reactivate — re-order (buy another SMS on) a completed number that supports reactivation, USD-native.
   *
   * A MONEY mutation that mirrors {@link create} EXACTLY on the idempotency
   * contract (key resolved up front, sent on the header, retried only on transient
   * failures with the SAME key, attached to the result, and stamped onto EVERY
   * thrown error). Returns the SAME create-result shape (the ONE reactivated child
   * order): each `amount` is projected to a USD {@link Money} and the FX receipt is
   * attached. `opts.max_price` is a USD-decimal string cost CEILING.
   */
  async reactivate(
    orderId: number,
    opts?: ReactivateOrderOptionsV2,
  ): Promise<CreateOrderResultV2> {
    const body: { id: number; max_price?: string } = { id: orderId };
    if (opts?.max_price !== undefined) body.max_price = opts.max_price;
    const { value } = await createWithIdempotency(
      this.request,
      "/v2/orders/reactivate",
      body,
      opts,
      decodeV2CreateResult,
    );
    return value;
  }

  /**
   * Reactivate-options — a read-only cost PREVIEW for {@link reactivate}, USD.
   *
   * Consumes NO idempotency key and writes nothing. The cost is projected to a USD
   * {@link Money} object and the FX receipt is attached. A missing `meta.fx` throws
   * a TYPED `INVALID_RESPONSE` (never a raw `TypeError`), consistent with the other
   * `/v2` reads.
   */
  async reactivateOptions(orderId: number): Promise<ReactivateOptionsV2> {
    const result = await this.request<{ cost: components["schemas"]["V2Money"] }>(
      "GET",
      `/v2/orders/${orderId}/reactivate-options`,
    );
    const fx = requireFx(result);
    const data = result.data as { cost: components["schemas"]["V2Money"] };
    return { cost: parseMoney(data.cost), fx };
  }

  /**
   * Poll until the order's OTP arrives, then resolve `{ otpCode, status, order }`.
   *
   * **Polls the FX-free `/v1/orders/{id}` path** (NOT `/v2`), so a `/v2` FX outage
   * (`503 FX_RATE_UNAVAILABLE`) can never break OTP-waiting. Throws
   * {@link OrderTerminalError} if the order goes terminal with no OTP, or
   * {@link OtpTimeoutError} once `timeoutMs` elapses.
   */
  waitForOtp(
    orderId: number,
    opts?: WaitForOtpOptions,
  ): Promise<OtpResult<V1OrderSummary>> {
    return waitForOtp(
      (id) => pollV1Order(this.request, id),
      orderId,
      opts,
    );
  }
}

/** The `/v1` orders surface (canonical IDR). */
export class V1OrdersResource {
  constructor(private readonly request: RequestFn) {}

  /**
   * Create (rent) one or more numbers, canonical IDR (money-safety idempotency).
   *
   * `req.max_price` is an IDR **integer** (minor units). Returns the IDR result
   * verbatim (`amount` is a plain IDR `number`) plus the resolved `idempotencyKey`.
   */
  async create(
    req: V1CreateOrderRequest,
    opts?: CreateOrderOptions,
  ): Promise<CreateOrderResultV1> {
    // `/v1` amounts are plain IDR numbers (no Money projection), so the decode is
    // trivial — but it still runs INSIDE the idempotency-stamp boundary so the
    // discipline is uniform with `/v2` (any future decode throw would be stamped).
    const { value } = await createWithIdempotency(
      this.request,
      "/v1/orders/create",
      req,
      opts,
      decodeV1CreateResult,
    );
    return value;
  }

  /** Fetch one order by id (IDR `amount`). */
  async get(id: number): Promise<V1OrderSummary> {
    const { data } = await this.request<V1OrderSummary>(
      "GET",
      `/v1/orders/${id}`,
    );
    return data as V1OrderSummary;
  }

  /** List orders (IDR `amount`). */
  async list(params: OrdersListParams = {}): Promise<V1OrderSummary[]> {
    const { data } = await this.request<V1OrderSummary[]>("GET", "/v1/orders", {
      query: {
        limit: params.limit,
        offset: params.offset,
        status: params.status,
      },
    });
    return data ?? [];
  }

  /** List active orders (money-free: status + OTP fields only). */
  async active(): Promise<V1OrderStatus[]> {
    const { data } = await this.request<V1OrderStatus[]>(
      "GET",
      "/v1/orders/active",
    );
    return data ?? [];
  }

  /** Cancel an order (and refund it), IDR verbatim. Not auto-retried (no idempotency key). */
  async cancel(orderId: number): Promise<V1CancelOrderResult> {
    const { data } = await mutateOrder<V1CancelOrderResult>(
      this.request,
      "/v1/orders/cancel",
      orderId,
    );
    return data;
  }

  /** Mark an order finished (money-free). Not auto-retried (no idempotency key). */
  async finish(orderId: number): Promise<V1FinishOrderResult> {
    const { data } = await mutateOrder<V1FinishOrderResult>(
      this.request,
      "/v1/orders/finish",
      orderId,
    );
    return data;
  }

  /** Ask the provider to resend the SMS (money-free). Not auto-retried (no idempotency key). */
  async resend(orderId: number): Promise<V1ResendResult> {
    const { data } = await mutateOrder<V1ResendResult>(
      this.request,
      "/v1/orders/resend",
      orderId,
    );
    return data;
  }

  /**
   * Reactivate — re-order (buy another SMS on) a completed number that supports reactivation, IDR.
   *
   * A MONEY mutation that mirrors {@link create} EXACTLY on the idempotency
   * contract. Returns the SAME create-result shape (the ONE reactivated child
   * order) with the IDR `amount` verbatim, plus the resolved `idempotencyKey`.
   * `opts.max_price` is an IDR-integer cost CEILING.
   */
  async reactivate(
    orderId: number,
    opts?: ReactivateOrderOptionsV1,
  ): Promise<CreateOrderResultV1> {
    const body: { id: number; max_price?: number } = { id: orderId };
    if (opts?.max_price !== undefined) body.max_price = opts.max_price;
    const { value } = await createWithIdempotency(
      this.request,
      "/v1/orders/reactivate",
      body,
      opts,
      decodeV1CreateResult,
    );
    return value;
  }

  /**
   * Reactivate-options — a read-only cost PREVIEW for {@link reactivate}, IDR.
   *
   * Consumes NO idempotency key and writes nothing. Returns the cost in IDR minor
   * units verbatim.
   */
  async reactivateOptions(orderId: number): Promise<ReactivateOptionsV1> {
    const { data } = await this.request<ReactivateOptionsV1>(
      "GET",
      `/v1/orders/${orderId}/reactivate-options`,
    );
    return data as ReactivateOptionsV1;
  }

  /**
   * Poll until the order's OTP arrives, then resolve `{ otpCode, status, order }`.
   *
   * Polls the FX-free `/v1/orders/{id}` path. Throws {@link OrderTerminalError} if
   * the order goes terminal with no OTP, or {@link OtpTimeoutError} once `timeoutMs`
   * elapses.
   */
  waitForOtp(
    orderId: number,
    opts?: WaitForOtpOptions,
  ): Promise<OtpResult<V1OrderSummary>> {
    return waitForOtp(
      (id) => pollV1Order(this.request, id),
      orderId,
      opts,
    );
  }
}

// Re-export the create item types for convenience (decoded vs raw).
// `V1CreateOrderRequest` / `V2CreateOrderRequest` are exported at their (ergonomic,
// optional-`quantity`) declaration above.
export type { V1CreateOrderItem, V2CreateOrderItem };
