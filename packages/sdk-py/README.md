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
        # No OTP evidence arrived. Cancel remains available only in that case.
        client.orders.cancel(order_id)
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

## Resend and wait for a new OTP

`finish` does not require a new OTP after resend; the order is finishable once it
has OTP evidence. If your integration needs to wait for a different post-resend
code, pass the previous code as `after_code`.

```py
first = client.orders.wait_for_otp(order_id)

client.orders.resend(order_id)

second = client.orders.wait_for_otp(
    order_id,
    after_code=first.otp_code,
    timeout_ms=120_000,
)

print("new OTP:", second.otp_code)
# Submit second.otp_code in your target app here, then finish.
client.orders.finish(order_id)
```

If the provider sends the same digits again, code-based polling cannot
distinguish it from the previous OTP.

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
