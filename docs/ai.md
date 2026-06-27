# SMSCode for AI Agents

Compact integration guidance for coding agents building on the SMSCode virtual-number API. Pair this with the OpenAPI contract and the [`@smscode/sdk`](https://github.com/smscode-gg/sdks) TypeScript/JavaScript client.

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

```bash
bun add @smscode/sdk    # or: npm i @smscode/sdk
```

## Recipe: create → waitForOtp → finish (cancel only on no-OTP)

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

// 2) Poll the FX-free /v1 status until the OTP arrives (survives a /v2 FX 503).
try {
  const { otpCode } = await client.orders.waitForOtp(orderId, {
    timeoutMs: 120_000,
  });
  console.log("OTP:", otpCode);
  // 3) Use the code in your target app, then FINISH the order. Once an OTP has
  //    arrived, cancel/refund is CLOSED — finish it (do NOT cancel).
  await client.orders.finish(orderId);
} catch (err) {
  // 4) No OTP (timeout or terminal-without-OTP) → cancel for a refund.
  if (err instanceof OtpTimeoutError || err instanceof OrderTerminalError) {
    await client.orders.cancel(orderId);
  } else {
    throw err;
  }
}

// `idempotencyKey` is the key to REUSE if you ever retry this exact create.
```

`max_price` units differ by version: `/v2` (`client.orders.create`) takes a **USD decimal string** (`"0.50"`); `/v1` (`client.v1.orders.create`) takes an **IDR integer**. `client.orders` is `/v2`; `client.v1.orders` is `/v1`.

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
  console.log(event.data.otp_code);
}
```
