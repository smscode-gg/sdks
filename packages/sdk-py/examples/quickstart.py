import os

from smscode import OrderTerminalError, OtpTimeoutError, SmscodeClient


def main() -> None:
    body = {
        "catalog_product_id": int(os.environ["SMSCODE_CATALOG_PRODUCT_ID"]),
        "max_price": "0.50",
        "quantity": 1,
    }

    with SmscodeClient(token=os.environ["SMSCODE_TOKEN"]) as client:
        created = client.orders.create(body)
        order_id = int(created.orders[0]["id"])

        try:
            otp = client.orders.wait_for_otp(order_id, timeout_ms=120_000)
            print("OTP:", otp.otp_code)
            # Submit otp.otp_code in your target app here.
            client.orders.finish(order_id)
        except (OtpTimeoutError, OrderTerminalError):
            client.orders.cancel(order_id)


if __name__ == "__main__":
    main()
