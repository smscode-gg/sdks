import os

from smscode import AsyncSmscodeClient, OrderTerminalError, OtpTimeoutError


async def main() -> None:
    body = {
        "catalog_product_id": int(os.environ["SMSCODE_CATALOG_PRODUCT_ID"]),
        "max_price": "0.50",
        "quantity": 1,
    }

    async with AsyncSmscodeClient(token=os.environ["SMSCODE_TOKEN"]) as client:
        created = await client.orders.create(body)
        order_id = int(created.orders[0]["id"])

        try:
            otp = await client.orders.wait_for_otp(order_id, timeout_ms=120_000)
            print("OTP:", otp.otp_code)
            # Submit otp.otp_code in your target app here.
            await client.orders.finish(order_id)
        except (OtpTimeoutError, OrderTerminalError):
            await client.orders.cancel(order_id)
