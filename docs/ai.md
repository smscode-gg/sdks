# SMSCode for AI Agents

Compact integration guidance for coding agents building on the SMSCode virtual-number API. Pair this with the OpenAPI contract and the official SDKs in [`smscode-gg/sdks`](https://github.com/smscode-gg/sdks): `@smscode/sdk` for TypeScript/JavaScript and `smscode` for Python.

- **OpenAPI contract (source of truth):** [`openapi.yaml`](https://smscode.gg/openapi.yaml) — hand-authored OpenAPI 3.1; every request/response shape lives here. Rendered for humans at <https://smscode.gg/docs>.
- **Base URL:** `https://api.smscode.gg`

## Rules

1. **Public surfaces only — `/v1` and `/v2`.** Use only the documented public surfaces; do not depend on undocumented endpoints — they are outside the public contract and may change without notice.
2. **Prefer `/v2` (USD-native).** `/v2` returns USD money objects with the exact IDR canonical amount and an FX receipt (`meta.fx`). `/v1` is the legacy IDR-only API (money is an integer in IDR minor units). Pick ONE version per integration; do not mix shapes.
3. **Auth is `Authorization: Bearer <token>`** on every request (token from Account Settings). No cookies, no separate API-key header.
4. **Idempotency is money safety.** Order create sends an `idempotency-key`. On a FAILED create, **retry with the SAME key — never mint a new one.** A new key on retry can double-charge you (the server dedups by key → at-most-once). With the SDK, the key is on the thrown error: reuse `error.idempotencyKey`.
5. **Honor `Retry-After`.** On `429` / `503`, the response sets a `Retry-After` header (seconds). Back off for that long before retrying. The SDK exposes it as `error.retryAfterSeconds` and applies it automatically when `maxRetries > 0`.

## Money shapes

`/v2` money is an object — a USD display amount (decimal string, never a float) over the canonical IDR ledger value:

```json
{ "amount": "0.9231", "currency": "USD", "canonical_amount": 15000, "canonical_currency": "IDR" }
```

Every `/v2` money-bearing response also carries `meta.fx { pair, rate, rate_as_of }`. `canonical_amount` is the exact IDR ledger truth; USD is a render-time projection, not a separate wallet. On `/v1` the same field is a plain IDR integer (e.g. `15000`).

## Error codes

Failures return `{ "success": false, "error": { "code", "message", "details"? } }`. **Branch on `error.code` (a stable enum), never on `error.message`.** The HTTP status per code is fixed by the contract:

| Code | HTTP | Meaning |
|------|------|---------|
| `UNAUTHORIZED` | 401 | Missing or invalid API token. |
| `FORBIDDEN` | 403 | Authenticated, but not permitted. |
| `NOT_FOUND` | 404 | The resource does not exist. |
| `VALIDATION_ERROR` | 422 | Request failed validation (bad/missing parameters). |
| `PROVIDER_ERROR` | 422 | An upstream SMS provider rejected or failed the operation. |
| `NO_OFFER_AVAILABLE` | 422 | No offer matches the requested product and policy. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | The key was reused with a *different* request body. |
| `INSUFFICIENT_BALANCE` | 409 | Account balance is too low for this operation. |
| `CONFLICT` | 409 | The request conflicts with the resource's current state. |
| `CANCEL_TOO_EARLY` | 409 | Canceled before the provider's minimum-cancel window; wait and retry. |
| `REQUEST_IN_PROGRESS` | 409 | A request with this key is still running; retry the same key shortly. |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests; back off and retry after `Retry-After`. |
| `TEMP_BANNED_ABUSE_GUARD` | 429 | Abuse guard tripped (high failure rate); see `details` + `Retry-After`. |
| `SERVICE_UNAVAILABLE` | 503 | Temporarily unavailable; retry later. |
| `FX_RATE_UNAVAILABLE` | 503 | The USD/IDR rate is temporarily unavailable (a `/v2`-only projection failure); retry later, or use `/v1`. |
| `INTERNAL_ERROR` | 500 | Unexpected server error. |

In the SDK each code maps to a typed subclass of `SmscodeError` (e.g. `RateLimitError`, `InsufficientBalanceError`, `IdempotencyKeyReuseError`). Transport failures are `NetworkError` / `TimeoutError` / `AbortError`; the `waitForOtp` helper adds `OrderTerminalError` and `OtpTimeoutError`.

## Install the SDK

TypeScript/JavaScript:

```bash
bun add @smscode/sdk    # or: npm i @smscode/sdk
```

Python:

```bash
pip install smscode
```

## Recipe: create → waitForOtp → finish (cancel only when `can_cancel`)

```ts
import {
  SmscodeClient,
  OtpTimeoutError,
  OrderTerminalError,
} from "@smscode/sdk";

const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });

// 1) Create a WhatsApp/Indonesia order. On /v2, `max_price` is a USD decimal
//    STRING (floor-converted to IDR server-side). The SDK resolves an
//    idempotency key up front and returns it on the result.
const { orders, idempotencyKey } = await client.orders.create({
  catalog_product_id: Number(process.env.SMSCODE_CATALOG_PRODUCT_ID),
  max_price: "0.50",
  quantity: 1,
});
const orderId = orders[0]!.id;

// 2) Poll the FX-free /v1 status until a classified code arrives. A delivered
//    SMS can have otp_message set and otp_code=null; this helper keeps polling.
try {
  const { otpCode } = await client.orders.waitForOtp(orderId, {
    timeoutMs: 120_000,
  });
  console.log("OTP:", otpCode);
  // 3) Use the code in your target app, then FINISH the order. Once any SMS has
  //    arrived, cancel/refund is CLOSED — finish it (do NOT cancel).
  await client.orders.finish(orderId);
} catch (err) {
  // 4) A helper error is not proof that no SMS arrived. Re-read the server state:
  //    a no-code SMS has otp_message set and can_cancel=false.
  if (err instanceof OtpTimeoutError || err instanceof OrderTerminalError) {
    const current = await client.orders.get(orderId);
    if (current.can_cancel) await client.orders.cancel(orderId);
  } else {
    throw err;
  }
}

// `idempotencyKey` is the key to REUSE if you ever retry this exact create.
```

`max_price` units differ by version: `/v2` (`client.orders.create`) takes a **USD decimal string** (`"0.50"`); `/v1` (`client.v1.orders.create`) takes an **IDR integer**. `client.orders` is `/v2`; `client.v1.orders` is `/v1`.

## Operator (carrier) selection

Some countries expose per-operator (carrier) tiers (e.g. Telkomsel). List them with `client.catalog.operators`, then pass `operator_id` to `client.catalog.products` (filter) and `client.orders.create` (routed path — with `catalog_product_id`). `operator_id`/`operator_name` are echoed on every product and order. An empty operators list means there is no operator choice — order the `any` tiers directly.

```ts
// Operators with stock for (country, service). `operator_id` is null for the synthesized `any` entry.
const operators = await client.catalog.operators({ country_id: 7, platform_id: 3 });
const op = operators.find((o) => o.code === "telkomsel"); // undefined ⇒ that carrier has no stock

const page = await client.catalog.products({ country_id: 7, platform_id: 3, operator_id: op?.operator_id });
const product = page.products.find((p) => p.available > 0 && p.active);

// Routed order to that operator. `operator_id`, `max_price`, and `min_price` are valid only with
// `catalog_product_id`; `max_price`/`min_price` are USD decimal strings on `/v2`, IDR integers on `/v1`.
const { orders } = await client.orders.create({
  catalog_product_id: product.catalog_product_id,
  operator_id: op?.operator_id,
});
```

## Reactivate a completed number

Some completed orders can be reactivated — re-order the SAME number for another code without renting a fresh one. Gate on the server-authoritative `can_reactivate`, preview the cost with `reactivateOptions` (read-only, no idempotency key, no charge), then `reactivate`. `reactivate` is a money mutation with the SAME idempotency contract as `create` (reuse `err.idempotencyKey` on a transient failure — never mint a new key) and returns the SAME shape as `create` (the one reactivated child order). On `/v2`, `reactivateOptions().cost` and the child `amount` are USD money objects; on `/v1` they are IDR integers.

```ts
const order = await client.orders.get(orderId);
if (!order.can_reactivate) throw new Error("not reactivatable");

const { cost } = await client.orders.reactivateOptions(orderId); // USD Money on /v2
const { orders } = await client.orders.reactivate(orderId, { max_price: "0.50" });
const child = orders[0]; // a NEW order — wait for its OTP, then finish
```

Python is the same lifecycle: `client.orders.get(order_id).capabilities.can_reactivate`, `client.orders.reactivate_options(order_id)`, then `client.orders.reactivate(order_id, max_price="0.50")`.

## Safe retry on a failed create

Always reuse the SAME idempotency key on retry — minting a new one risks a double charge:

```ts
import { SmscodeClient, SmscodeError } from "@smscode/sdk";

const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });

const body = {
  catalog_product_id: Number(process.env.SMSCODE_CATALOG_PRODUCT_ID),
  max_price: "0.50",
  quantity: 1,
};

async function createOnce() {
  try {
    return await client.orders.create(body);
  } catch (err) {
    if (err instanceof SmscodeError && err.idempotencyKey) {
      // Retry with the SAME key — never a fresh one.
      return await client.orders.create(body, {
        idempotencyKey: err.idempotencyKey,
      });
    }
    throw err;
  }
}
```

## Webhooks

Configure a delivery URL + signing secret, then verify every inbound delivery:

```ts
import { verifyWebhookSignature, parseWebhookEvent } from "@smscode/sdk";

// In your webhook HTTP handler — verify the RAW body bytes (never re-serialized JSON).
const ok = await verifyWebhookSignature(
  rawBody, // string | Uint8Array, exactly as received
  request.headers["x-webhook-signature"], // "sha256=<hex>"
  process.env.SMSCODE_WEBHOOK_SECRET!,
);
if (!ok) return new Response("bad signature", { status: 401 });

const event = parseWebhookEvent(rawBody);
if (event.event === "order.otp_received") {
  if (event.data.otp_code) console.log("OTP:", event.data.otp_code);
  else console.log("SMS received without a classified code:", event.data.otp_message);
}
```

`order.otp_received` is the stable event name for every novel SMS. `otp_code` is nullable and `otp_message` carries the exact SMS text. Delivery is unordered when multiple SMS messages arrive quickly, but each event contains a self-consistent aggregate code/message snapshot. A retained code may come from an earlier SMS than the latest message, so do not assume both fields coexisted in one provider message. Use the monotonic `sms_revision` to reject an older aggregate pair.

## Python SDK recipe

Python uses snake_case names but follows the same lifecycle and idempotency rules:

```py
import os

from smscode import OtpTimeoutError, OrderTerminalError, SmscodeClient

client = SmscodeClient(token=os.environ["SMSCODE_TOKEN"])

body = {
    "catalog_product_id": int(os.environ["SMSCODE_CATALOG_PRODUCT_ID"]),
    "max_price": "0.50",  # /v2 USD decimal string
    "quantity": 1,
}

with client:
    created = client.orders.create(body)
    order_id = int(created.orders[0]["id"])

    try:
        otp = client.orders.wait_for_otp(order_id, timeout_ms=120_000)
        # Submit otp.otp_code in your target app here.
        client.orders.finish(order_id)
    except (OtpTimeoutError, OrderTerminalError):
        current = client.orders.get(order_id)
        if current["can_cancel"]:
            client.orders.cancel(order_id)
```

For resend flows, preserve the previous code:

```py
first = client.orders.wait_for_otp(order_id)
client.orders.resend(order_id)
second = client.orders.wait_for_otp(order_id, after_code=first.otp_code)
```

Verify Python webhook signatures with raw bytes:

```py
from smscode import parse_webhook_event, verify_webhook_signature

if not verify_webhook_signature(raw_body, signature_header or "", secret):
    return 401
event = parse_webhook_event(raw_body)
if event["event"] == "order.otp_received":
    print(event["data"].get("otp_code"), event["data"].get("otp_message"))
```
