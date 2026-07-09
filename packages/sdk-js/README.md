# @smscode/sdk

Official TypeScript/JavaScript SDK for the [SMSCode](https://smscode.gg) virtual-number API — rent temporary phone numbers and receive one-time SMS verification codes (OTP) programmatically.

- **USD-native by default** (`/v2`): money is a typed object over the canonical IDR ledger, with an FX receipt. The legacy IDR API (`/v1`) is available under `client.v1.*`.
- **Money-safe order create**: every create carries an idempotency key, retried only on transient failures with the SAME key, and the key is stamped onto every thrown error so a retry is always safe.
- **Typed errors**: branch on `instanceof` (or `err.code`), never on `err.message`.
- **Zero runtime dependencies**, isomorphic (Node 18+, Bun, Deno, browsers — anything with `fetch` + Web Crypto).

> AI agents: see [`docs/ai.md`](https://github.com/smscode-gg/sdks/blob/main/docs/ai.md) for compact integration rules. Coding agents should **prefer `/v2`** and use only the documented public API surfaces.

## Install

```bash
bun add @smscode/sdk
# or
npm i @smscode/sdk
```

## Quick start

```ts
import { SmscodeClient } from "@smscode/sdk";

const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });

const { balance } = await client.balance.get(); // USD balance over the IDR ledger
console.log(`USD balance: ${balance.amount} (canonical ${balance.canonicalAmount} IDR)`);
```

`client.*` is the `/v2` (USD) surface; `client.v1.*` is the canonical `/v1` (IDR) surface.

The examples below read configuration from the environment — no secrets in source:

| Variable | Purpose |
|----------|---------|
| `SMSCODE_TOKEN` | Your API token (Account Settings → API). |
| `SMSCODE_PLATFORM_ID` | A service/platform id to filter the catalog by (from `client.catalog.services()`, e.g. WhatsApp). |
| `SMSCODE_CATALOG_PRODUCT_ID` | A catalog product id to order (e.g. WhatsApp / Indonesia). |
| `SMSCODE_ORDER_ID` | An existing order id to cancel (example 2). |
| `SMSCODE_WEBHOOK_URL` | Your webhook delivery URL (example 3). |
| `SMSCODE_WEBHOOK_SECRET` | Your webhook signing secret (examples 3 & 4). |
| `SMSCODE_BASE_URL` | Optional API origin override (defaults to `https://api.smscode.gg`). |

---

## Example 1 — Create a WhatsApp/Indonesia order, then wait for the OTP

`client.orders.create` resolves an idempotency key up front and returns it on the result. `max_price` on `/v2` is a **USD decimal string** (floor-converted to IDR server-side). `waitForOtp` polls the FX-free `/v1` status, so a `/v2` FX outage can never break OTP-waiting.

```ts
import { SmscodeClient, OtpTimeoutError, OrderTerminalError } from "@smscode/sdk";

const client = new SmscodeClient({
  token: process.env.SMSCODE_TOKEN!,
  // `baseUrl` is optional — only pass it when actually set (omit, don't pass undefined).
  ...(process.env.SMSCODE_BASE_URL ? { baseUrl: process.env.SMSCODE_BASE_URL } : {}),
});

// Pick a WhatsApp/Indonesia product from the catalog (country_id 7 = Indonesia).
// `platform_id` is the service id from `client.catalog.services()`.
const page = await client.catalog.products({
  country_id: 7,
  platform_id: Number(process.env.SMSCODE_PLATFORM_ID), // e.g. WhatsApp
});
// `available` is a stock count — order only an in-stock, orderable product.
const product = page.products.find((p) => p.available > 0 && p.active);
if (!product?.catalog_product_id) throw new Error("No available product");

// Create (rent) the number. The result carries the resolved idempotency key.
const { orders, idempotencyKey } = await client.orders.create({
  catalog_product_id: product.catalog_product_id,
  max_price: "0.50", // USD decimal string
  quantity: 1,
});
const order = orders[0]!;
console.log(`Order ${order.id} created (key ${idempotencyKey}); amount ${order.amount.amount} USD`);

// Wait up to 2 minutes for the verification code, then finish the order.
try {
  const { otpCode, status } = await client.orders.waitForOtp(order.id, {
    timeoutMs: 120_000,
  });
  console.log(`OTP ${otpCode} (status ${status})`);
  // Use the code in your target app, then FINISH. Once an OTP has arrived,
  // cancel/refund is closed — finish the order (see Example 2 for the no-OTP path).
  await client.orders.finish(order.id);
} catch (err) {
  // No OTP (timeout or terminal-without-OTP) → cancel for a refund.
  if (err instanceof OtpTimeoutError || err instanceof OrderTerminalError) {
    await client.orders.cancel(order.id);
  } else throw err;
}
```

### Waiting for a *new* OTP after a resend

If you `resend` an order, the previous OTP is preserved server-side, so a plain `waitForOtp` resolves immediately on that stale code. Pass `afterCode` (the code you already saw) to wait for a genuinely new one:

```ts
const first = await client.orders.waitForOtp(order.id, { timeoutMs: 120_000 });

await client.orders.resend(order.id); // re-open the order; the old code is preserved

// Wait for a NEW code — the stale `first.otpCode` is skipped.
const next = await client.orders.waitForOtp(order.id, {
  afterCode: first.otpCode,
  timeoutMs: 120_000,
});
console.log(`new OTP ${next.otpCode}`);
// Use `next.otpCode`, then finish the order (as in Example 1) — do not cancel after an OTP.
await client.orders.finish(order.id);
```

> Limitation: if the resent OTP has the **same digits** as the previous one, it can't be distinguished from the stale code (an observability/UX edge — the money lifecycle is unaffected).

## Example 2 — Cancel an order (and refund it)

`cancel` is not auto-retried (no idempotency key). On `/v2` both money fields are typed USD objects.

> **Cancel only refunds an order that has not received an OTP.** Once an OTP arrives, the order is consumed and cancel/refund is closed — `finish` it instead (Example 1).

```ts
import { SmscodeClient } from "@smscode/sdk";

const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });

const orderId = Number(process.env.SMSCODE_ORDER_ID);
const result = await client.orders.cancel(orderId);
console.log(
  `Canceled order ${result.order_id}; refunded ${result.refund_amount.amount} USD, ` +
    `new balance ${result.new_balance.amount} USD`,
);
```

## Example 3 — Configure and test a webhook, then verify a signature

Set your delivery URL + signing secret, send a test event, and verify the signature exactly the way your webhook handler will. `verifyWebhookSignature` recomputes the HMAC-SHA256 over the **raw bytes** in constant time.

```ts
import {
  SmscodeClient,
  verifyWebhookSignature,
  parseWebhookEvent,
} from "@smscode/sdk";

const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });
const secret = process.env.SMSCODE_WEBHOOK_SECRET!;

// 1) Configure the outbound webhook (pass "" to clear a field).
await client.webhook.update({
  webhook_url: process.env.SMSCODE_WEBHOOK_URL!,
  webhook_secret: secret,
});

// 2) Fire a test delivery; the result is the HTTP status your endpoint returned.
const { status_code } = await client.webhook.test();
console.log(`Webhook test → your endpoint replied ${status_code}`);

// 3) In your webhook HTTP handler, verify the RAW body before trusting it.
//    (Illustrative — `rawBody` and `signatureHeader` come from the inbound request.)
async function handleDelivery(rawBody: string, signatureHeader: string) {
  const ok = await verifyWebhookSignature(rawBody, signatureHeader, secret);
  if (!ok) throw new Error("Invalid webhook signature");

  const event = parseWebhookEvent(rawBody);
  if (event.event === "order.otp_received") {
    console.log("OTP received:", event.data.otp_code);
  }
}
```

## Example 4 — Typed error handling + safe idempotent retry

Catch `SmscodeError` subclasses to branch on failure type. On a failed **create**, reuse `error.idempotencyKey` — never mint a new key, or you risk a double charge.

```ts
import {
  SmscodeClient,
  SmscodeError,
  InsufficientBalanceError,
  RateLimitError,
} from "@smscode/sdk";

const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });

const body = {
  catalog_product_id: Number(process.env.SMSCODE_CATALOG_PRODUCT_ID),
  max_price: "0.50",
  quantity: 1,
};

try {
  const { orders } = await client.orders.create(body);
  console.log("Created:", orders[0]!.id);
} catch (err) {
  if (err instanceof InsufficientBalanceError) {
    console.error("Top up your balance, then retry.");
  } else if (err instanceof RateLimitError) {
    console.error(`Rate limited — retry after ${err.retryAfterSeconds ?? "?"}s.`);
  } else if (err instanceof SmscodeError && err.idempotencyKey) {
    // Transient/unknown failure on a create: retry with the SAME key.
    const { orders } = await client.orders.create(body, {
      idempotencyKey: err.idempotencyKey,
    });
    console.log("Created on retry:", orders[0]!.id);
  } else {
    throw err;
  }
}
```

## Example 5 — Order a specific operator (carrier)

Some countries expose per-operator (carrier) tiers, e.g. Telkomsel or XL. `client.catalog.operators` lists the operators that currently have stock for a `(country, service)`, plus a synthesized `any` coordinate (null `operator_id`) when the carrier-agnostic tiers also have stock — an empty list means there is no operator choice (order the `any` tiers directly). Pass an `operator_id` to `client.catalog.products` to filter the catalog, and to `client.orders.create` on the routed path (with `catalog_product_id`) to rent a number from that carrier. Every product and order echoes `operator_id`/`operator_name`.

```ts
// 1. Operators with stock for WhatsApp / Indonesia (country_id 7).
const operators = await client.catalog.operators({
  country_id: 7,
  platform_id: Number(process.env.SMSCODE_PLATFORM_ID),
});
// `operator_id` is null for the synthesized `any` (carrier-agnostic) entry.
const telkomsel = operators.find((o) => o.code === "telkomsel");
if (!telkomsel?.operator_id) throw new Error("Telkomsel has no stock right now");

// 2. Filter the catalog to that operator's tiers.
const page = await client.catalog.products({
  country_id: 7,
  platform_id: Number(process.env.SMSCODE_PLATFORM_ID),
  operator_id: telkomsel.operator_id,
});
const product = page.products.find((p) => p.available > 0 && p.active);
if (!product?.catalog_product_id) throw new Error("No available Telkomsel product");

// 3. Rent a number routed to that operator (routed path → `catalog_product_id`).
//    `operator_id`, `max_price` (USD ceiling), and `min_price` (USD floor) are
//    routing knobs valid only with `catalog_product_id`.
const { orders } = await client.orders.create({
  catalog_product_id: product.catalog_product_id,
  operator_id: telkomsel.operator_id,
  max_price: "0.50", // USD decimal string
});
const order = orders[0]!;
console.log(`Order ${order.id} — operator ${order.operator_name} (#${order.operator_id})`);
```

## Example 6 — Reactivate a completed number

Some completed orders can be **reactivated** — re-order the SAME number to receive another code on it, without renting a fresh number. Check `can_reactivate` on the order (it is server-authoritative), preview the cost, then reactivate. `reactivate` is a money mutation with the SAME idempotency contract as `create` — reuse `error.idempotencyKey` on a transient failure, never mint a new key. It returns the SAME shape as `create` (the one reactivated child order).

```ts
import { SmscodeClient } from "@smscode/sdk";

const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });

const orderId = Number(process.env.SMSCODE_ORDER_ID);

// 1. Only a completed order whose number supports reactivation qualifies.
const order = await client.orders.get(orderId);
if (!order.can_reactivate) throw new Error("This order cannot be reactivated");

// 2. Preview the current cost (read-only — no idempotency key, no charge).
const { cost } = await client.orders.reactivateOptions(orderId);
console.log(`Reactivation costs ${cost.amount} USD`);

// 3. Reactivate. `max_price` (USD decimal string) caps the cost; the child is a NEW order.
const { orders } = await client.orders.reactivate(orderId, { max_price: "0.50" });
const child = orders[0]!;
console.log(`Reactivated as order ${child.id}; charged ${child.amount.amount} USD`);

// Then wait for the new OTP exactly as in Example 1.
const otp = await client.orders.waitForOtp(child.id, { timeoutMs: 120_000 });
console.log(`new OTP ${otp.otpCode}`);
await client.orders.finish(child.id);
```

## Error model

Every failure is a `SmscodeError` (or a subclass). Business failures carry a stable `code`; the 16 codes map to typed subclasses — `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ValidationError`, `ProviderError`, `NoOfferAvailableError`, `IdempotencyKeyReuseError`, `InsufficientBalanceError`, `ConflictError`, `CancelTooEarlyError`, `RequestInProgressError`, `RateLimitError`, `TempBannedError`, `ServiceUnavailableError`, `FxRateUnavailableError`, `InternalError`. Transport failures are `NetworkError` / `TimeoutError` / `AbortError`; `waitForOtp` adds `OrderTerminalError` and `OtpTimeoutError`. On `429`/`503`, `err.retryAfterSeconds` reflects the `Retry-After` header. See [`docs/ai.md`](https://github.com/smscode-gg/sdks/blob/main/docs/ai.md) for the full code → HTTP-status table.

## Smoke test

`examples/smoke.ts` runs an end-to-end `create → waitForOtp → finish` (cancel only on no-OTP) against a test account. It is **gated** and places **no order** unless explicitly enabled:

```bash
# Default: dry run — verifies config/read paths and exits before any create.
bun run examples/smoke.ts

# Funded end-to-end (explicitly enabled — this DOES place a real order):
SMSCODE_E2E_FUNDED=1 SMSCODE_TOKEN=... SMSCODE_CATALOG_PRODUCT_ID=... bun run examples/smoke.ts
```

## License

MIT
