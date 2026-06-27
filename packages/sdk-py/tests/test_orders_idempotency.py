import asyncio

import httpx
import pytest
import respx

from smscode import (
    AsyncSmscodeClient,
    InvalidMoneyError,
    InvalidResponseError,
    RequestCancelledError,
    SmscodeClient,
    ValidationError,
    is_valid_idempotency_key,
)


def test_generated_create_key_is_returned_and_valid() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.post("/v1/orders/create").respond(
            200,
            json={"success": True, "data": {"orders": [], "failed_count": 0}},
        )
        with SmscodeClient(token="tok") as client:
            result = client.v1.orders.create({"product_id": 10})

    assert is_valid_idempotency_key(result.idempotency_key)


def test_invalid_key_fails_before_request() -> None:
    with respx.mock(base_url="https://api.smscode.gg", assert_all_called=False) as router:
        route = router.post("/v1/orders/create").respond(200, json={"success": True, "data": {}})
        with SmscodeClient(token="tok") as client, pytest.raises(ValidationError):
            client.v1.orders.create({"product_id": 10}, idempotency_key="not valid")
    assert not route.called


def test_api_error_carries_create_key() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.post("/v1/orders/create").respond(
            422,
            json={"success": False, "error": {"code": "VALIDATION_ERROR", "message": "bad"}},
        )
        with SmscodeClient(token="tok") as client, pytest.raises(ValidationError) as exc:
            client.v1.orders.create({"product_id": 10}, idempotency_key="stable-key")
    assert exc.value.idempotency_key == "stable-key"


def test_network_and_timeout_errors_carry_create_key() -> None:
    for error in [httpx.ConnectError("boom"), httpx.TimeoutException("slow")]:
        with respx.mock(base_url="https://api.smscode.gg") as router:
            router.post("/v1/orders/create").mock(side_effect=error)
            with SmscodeClient(token="tok") as client, pytest.raises(Exception) as exc:
                client.v1.orders.create({"product_id": 10}, idempotency_key="stable-key")
        assert getattr(exc.value, "idempotency_key", None) == "stable-key"


def test_retry_exhaustion_carries_create_key() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.post("/v1/orders/create").respond(
            503,
            json={
                "success": False,
                "error": {"code": "SERVICE_UNAVAILABLE", "message": "down"},
            },
        )
        with SmscodeClient(token="tok", max_retries=1) as client, pytest.raises(Exception) as exc:
            client.v1.orders.create({"product_id": 10}, idempotency_key="stable-key")

    assert route.call_count == 2
    assert getattr(exc.value, "idempotency_key", None) == "stable-key"


def test_v1_create_missing_orders_raises_stamped_invalid_response() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.post("/v1/orders/create").respond(200, json={"success": True, "data": {}})
        with SmscodeClient(token="tok") as client, pytest.raises(InvalidResponseError) as exc:
            client.v1.orders.create({"product_id": 10}, idempotency_key="stable-key")
    assert exc.value.idempotency_key == "stable-key"


def test_v2_create_malformed_money_raises_stamped_invalid_money() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.post("/v2/orders/create").respond(
            200,
            json={
                "success": True,
                "data": {"orders": [{"id": 1, "amount": None}], "failed_count": 0},
                "meta": {"fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None}},
            },
        )
        with SmscodeClient(token="tok") as client, pytest.raises(InvalidMoneyError) as exc:
            client.orders.create({"product_id": 10}, idempotency_key="stable-key")
    assert exc.value.idempotency_key == "stable-key"


@pytest.mark.asyncio
async def test_async_create_cancellation_carries_key() -> None:
    async def never_returns(request: httpx.Request) -> httpx.Response:
        raise asyncio.CancelledError

    transport = httpx.MockTransport(never_returns)
    async with AsyncSmscodeClient(token="tok", transport=transport) as client:
        with pytest.raises(RequestCancelledError) as exc:
            await client.orders.create({"product_id": 10}, idempotency_key="stable-key")
    assert exc.value.idempotency_key == "stable-key"
