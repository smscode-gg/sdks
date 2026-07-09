import pytest
import respx

from smscode import (
    AsyncSmscodeClient,
    CreatedOrder,
    FinishResult,
    Money,
    Order,
    ResendResult,
    ServiceUnavailableError,
    SmscodeClient,
)

OTP_RECEIVED_V1_RESPONSE = {
    "success": True,
    "data": {
        "id": 1,
        "status": "OTP_RECEIVED",
        "product_id": 10,
        "amount": 139,
        "otp_code": "123456",
        "can_finish": True,
        "can_resend": True,
        "can_cancel": False,
        "can_replace": False,
        "can_reactivate": False,
        "resend_available_at": None,
        "cancel_available_at": None,
        "replace_available_at": None,
    },
}


def test_v2_create_sends_key_and_decodes_money() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.post("/v2/orders/create").respond(
            200,
            json={
                "success": True,
                "data": {
                    "orders": [
                        {
                            "id": 1,
                            "status": "ACTIVE",
                            "amount": {
                                "amount": "0.0077",
                                "currency": "USD",
                                "canonical_amount": 139,
                                "canonical_currency": "IDR",
                            },
                            "otp_code": None,
                            "can_finish": False,
                            "can_resend": False,
                            "can_cancel": False,
                            "can_replace": False,
                            "can_reactivate": False,
                            "resend_available_at": None,
                            "cancel_available_at": "2026-06-27T09:00:00Z",
                            "replace_available_at": "2026-06-27T09:00:00Z",
                        }
                    ],
                    "failed_count": 0,
                },
                "meta": {"fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None}},
            },
        )
        with SmscodeClient(token="tok") as client:
            result = client.orders.create(
                catalog_product_id=10,
                max_price="0.50",
                quantity=1,
                idempotency_key="stable-key",
            )

    assert route.calls[0].request.headers["idempotency-key"] == "stable-key"
    assert route.calls[0].request.content == (
        b'{"catalog_product_id":10,"max_price":"0.50","quantity":1}'
    )
    assert result.idempotency_key == "stable-key"
    assert isinstance(result.orders[0], CreatedOrder)
    assert result.orders[0].amount == Money(
        amount="0.0077",
        currency="USD",
        canonical_amount=139,
        canonical_currency="IDR",
    )


def test_v1_create_returns_idr_shape() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.post("/v1/orders/create").respond(
            200,
            json={
                "success": True,
                "data": {
                    "orders": [
                        {
                            "id": 1,
                            "status": "ACTIVE",
                            "product_id": 10,
                            "amount": 139,
                            "can_finish": False,
                            "can_resend": False,
                            "can_cancel": False,
                            "can_replace": False,
                            "can_reactivate": False,
                            "resend_available_at": None,
                            "cancel_available_at": "2026-06-27T09:00:00Z",
                            "replace_available_at": "2026-06-27T09:00:00Z",
                        }
                    ],
                    "failed_count": 0,
                },
            },
        )
        with SmscodeClient(token="tok") as client:
            result = client.v1.orders.create(product_id=10, idempotency_key="stable-key")

    assert isinstance(result.orders[0], CreatedOrder)
    assert result.orders[0]["id"] == 1
    assert result.orders[0].amount == 139
    assert result.idempotency_key == "stable-key"


def test_v1_wait_for_otp_resolves_decoded_order_model() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v1/orders/1").respond(200, json=OTP_RECEIVED_V1_RESPONSE)
        with SmscodeClient(token="tok") as client:
            result = client.v1.orders.wait_for_otp(
                1,
                timeout_ms=1,
                poll_interval_ms=3000,
                sleep=lambda seconds: None,
                now=lambda: 0.0,
            )

    assert result.otp_code == "123456"
    assert result.status == "OTP_RECEIVED"
    assert isinstance(result.order, Order)


@pytest.mark.asyncio
async def test_async_v1_wait_for_otp_resolves_decoded_order_model() -> None:
    async def sleep(_seconds: float) -> None:
        return None

    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v1/orders/1").respond(200, json=OTP_RECEIVED_V1_RESPONSE)
        async with AsyncSmscodeClient(token="tok") as client:
            result = await client.v1.orders.wait_for_otp(
                1,
                timeout_ms=1,
                poll_interval_ms=3000,
                sleep=sleep,
                now=lambda: 0.0,
            )

    assert result.otp_code == "123456"
    assert result.status == "OTP_RECEIVED"
    assert isinstance(result.order, Order)


def test_order_get_finish_and_resend_return_typed_models() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/orders/1").respond(
            200,
            json={
                "success": True,
                "data": {
                    "id": 1,
                    "status": "OTP_RECEIVED",
                    "amount": {
                        "amount": "0.0077",
                        "currency": "USD",
                        "canonical_amount": 139,
                        "canonical_currency": "IDR",
                    },
                    "can_finish": True,
                    "can_resend": True,
                    "can_cancel": False,
                    "can_replace": False,
                    "can_reactivate": False,
                    "resend_available_at": None,
                    "cancel_available_at": None,
                    "replace_available_at": None,
                },
                "meta": {"fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None}},
            },
        )
        router.post("/v2/orders/finish").respond(
            200,
            json={"success": True, "data": {"order_id": 1, "status": "COMPLETED"}},
        )
        router.post("/v2/orders/resend").respond(
            200,
            json={"success": True, "data": {"order_id": 1, "status": "ACTIVE", "resent": True}},
        )
        with SmscodeClient(token="tok") as client:
            order = client.orders.get(1)
            finish = client.orders.finish(1)
            resend = client.orders.resend(1)

    assert isinstance(order, Order)
    assert order.capabilities.can_finish is True
    assert order.amount == Money(
        amount="0.0077",
        currency="USD",
        canonical_amount=139,
        canonical_currency="IDR",
    )
    assert isinstance(finish, FinishResult)
    assert finish.status == "COMPLETED"
    assert isinstance(resend, ResendResult)
    assert resend.resent is True


def test_cancel_is_not_auto_retried() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.post("/v2/orders/cancel").respond(
            503,
            json={
                "success": False,
                "error": {"code": "SERVICE_UNAVAILABLE", "message": "down"},
            },
        )
        with (
            SmscodeClient(token="tok", max_retries=1) as client,
            pytest.raises(ServiceUnavailableError),
        ):
            client.orders.cancel(1)

    assert route.call_count == 1
