# smscode

Official Python SDK for the SMSCode virtual-number API.

Use it to rent temporary phone numbers, receive SMS OTP verification codes, and
manage order lifecycle from Python services, bots, and automations.

## Install

```bash
pip install smscode
```

Requires Python 3.10+.

## Quick start

`SmscodeClient` uses the USD-native `/v2` API by default. Money values are typed
objects with the exact IDR ledger amount preserved as `canonical_amount`.

```py
import os

from smscode import OtpTimeoutError, OrderTerminalError, SmscodeClient

client = SmscodeClient(token=os.environ["SMSCODE_TOKEN"])

body = {
    "catalog_product_id": int(os.environ["SMSCODE_CATALOG_PRODUCT_ID"]),
    "max_price": "0.50",  # /v2 uses a USD decimal string, never a float
    "quantity": 1,
}

with client:
    created = client.orders.create(body)
    order = created.orders[0]
    order_id = int(order["id"])

    try:
        otp = client.orders.wait_for_otp(order_id, timeout_ms=120_000)
        print("OTP:", otp.otp_code)
        # Submit otp.otp_code in your target app here.
        client.orders.finish(order_id)
    except (OtpTimeoutError, OrderTerminalError):
        # A helper error is not proof that no SMS arrived. A no-code SMS has
        # otp_message set and can_cancel=False, so re-read capabilities first.
        current = client.v1.orders.get(order_id)
        if current["can_finish"]:
            print("SMS received:", current.get("otp_message") or "no classified code")
            client.orders.finish(order_id)
        elif current["can_cancel"]:
            client.orders.cancel(order_id)
        else:
            print(f"Order {order_id} is {current['status']}; no automatic action taken")
```

`wait_for_otp` waits for a classified code. Active-order reads and webhooks still expose a delivered SMS when `otp_code` is `None` and `otp_message` contains the exact message text. Rapid SMS webhook deliveries are unordered; compare `sms_revision` and ignore an older code/message pair.

## Operator (carrier) selection

Some countries expose per-operator (carrier) tiers (e.g. Telkomsel). `client.catalog.operators` lists the operators with stock for a `(country, service)`, plus a synthesized `any` (null `operator_id`) when the carrier-agnostic tiers also have stock — an empty list means there is no operator choice (order the `any` tiers directly). Pass `operator_id` to `catalog.products` (filter) and to `orders.create` on the routed path (with `catalog_product_id`). Products and orders carry `operator_id`/`operator_name`.

```py
with client:
    operators = client.catalog.operators(country_id=7, platform_id=3)
    op = next((o for o in operators if o.code == "telkomsel"), None)
    if op is None or op.operator_id is None:
        raise SystemExit("Telkomsel has no stock right now")

    page = client.catalog.products(country_id=7, platform_id=3, operator_id=op.operator_id)
    product = next((p for p in page.products if p.available > 0 and p.active), None)

    # Routed order to that operator. operator_id / max_price / min_price are valid only with
    # catalog_product_id (max_price/min_price are USD decimal strings on /v2, IDR integers on /v1).
    created = client.orders.create({
        "catalog_product_id": product.catalog_product_id,
        "operator_id": op.operator_id,
        "max_price": "0.50",
    })
    order = created.orders[0]
    print("operator:", order["operator_name"], order["operator_id"])
```

## Async client

The async client has the same surface and uses `httpx.AsyncClient` internally.

```py
import os

from smscode import AsyncSmscodeClient


async def main() -> None:
    async with AsyncSmscodeClient(token=os.environ["SMSCODE_TOKEN"]) as client:
        balance = await client.balance.get()
        print(balance.balance.amount, balance.balance.currency)
```

## Resend and wait for a new SMS

`finish` does not require a new OTP after resend; the order is finishable once it
has SMS delivery evidence. To distinguish a new delivery from the preserved
aggregate code, pass both the previous code and revision.

```py
first = client.orders.wait_for_otp(order_id)

client.orders.resend(order_id)

second = client.orders.wait_for_otp(
    order_id,
    after_code=first.otp_code,
    after_revision=int(first.order["sms_revision"]),
    timeout_ms=120_000,
)

print("latest SMS:", second.order.get("otp_message"))
# second.otp_code can equal the old code after a text/link-only follow-up.
client.orders.finish(order_id)
```

With only `after_code`, identical digits remain indistinguishable. With only
`after_revision`, the helper waits for a strictly newer revision. A first-ever
text/link-only SMS still has no aggregate code to return, so use the order's
`otp_message` and server capabilities after the helper times out.

## Reactivate a completed number

Some completed orders can be **reactivated** — re-order the SAME number for another
code, without renting a fresh one. Check `can_reactivate` (server-authoritative),
preview the cost, then reactivate. `reactivate` is money-sensitive with the same
idempotency contract as `create`, and returns the same result shape (the one
reactivated child order). `reactivate_options` is a read-only preview (no key, no
charge): on `/v2` `cost` is a USD `Money`; on `/v1` it is an IDR integer.

```py
order = client.orders.get(order_id)
if not order.capabilities.can_reactivate:
    raise SystemExit("This order cannot be reactivated")

# Read-only cost preview.
preview = client.orders.reactivate_options(order_id)
print("reactivation cost:", preview.cost.amount, "USD")

# Reactivate. max_price (USD decimal string) caps the cost; the child is a NEW order.
result = client.orders.reactivate(order_id, max_price="0.50")
child = result.orders[0]
print("reactivated as:", child["id"], "charged", child.amount.amount, "USD")

# Then wait for the new OTP and finish, as in the quick start.
otp = client.orders.wait_for_otp(int(child["id"]), timeout_ms=120_000)
client.orders.finish(int(child["id"]))
```

## Idempotent order create

Order create is money-sensitive. The SDK resolves an idempotency key before the
request, sends it as `idempotency-key`, and attaches it to create errors.

```py
from smscode import SmscodeError

try:
    created = client.orders.create(body)
except SmscodeError as err:
    if err.idempotency_key is None:
        raise
    # Retry the exact same body with the same key. Never mint a fresh key for
    # the same attempted create.
    created = client.orders.create(body, idempotency_key=err.idempotency_key)
```

## Webhooks

Verify webhook signatures against the raw request body before parsing JSON.

```py
from smscode import parse_webhook_event, verify_webhook_signature


def handle_webhook(raw_body: bytes, signature_header: str | None, secret: str) -> int:
    if not verify_webhook_signature(raw_body, signature_header or "", secret):
        return 401

    event = parse_webhook_event(raw_body)
    if event["event"] == "order.otp_received":
        print(event["data"]["otp_code"])
    return 204
```

## `/v1` namespace

Use `.v1` only when you intentionally want legacy IDR-only shapes.

```py
with SmscodeClient(token=os.environ["SMSCODE_TOKEN"]) as client:
    balance_v2 = client.balance.get()
    balance_v1 = client.v1.balance.get()
```

## Error handling

Every API error is a typed `SmscodeError` subclass. Branch on the class or
`err.code`, not on `err.message`. `RateLimitError` and retryable server errors
carry `retry_after_seconds` when the API sends `Retry-After`.

## License

MIT
