"""Order reactivation (`reactivate` + `reactivate_options`).

`reactivate` re-orders (buys another SMS on) a completed HERO number. It is a
MONEY mutation and mirrors `create` on the idempotency contract: the key is
resolved up front, sent on the ``idempotency-key`` header, and stamped onto every
thrown error. It returns the SAME create-result shape (the ONE reactivated child):
``/v2`` projects ``amount`` to a USD :class:`Money` + carries the FX receipt,
``/v1`` returns the IDR amount verbatim.

``reactivate_options`` is a read-only cost preview (NO idempotency key): ``/v2``
returns the cost as a USD :class:`Money` + the FX receipt, ``/v1`` the IDR int.
"""

from __future__ import annotations

import pytest
import respx

from smscode import (
    AsyncSmscodeClient,
    CreatedOrder,
    IdempotencyKeyReuseError,
    Money,
    ReactivateOptions,
    ReactivateOptionsV2,
    SmscodeClient,
    V2Fx,
)

# Server-authoritative caps of a freshly reactivated (age ~0) child order.
FRESH_CAPS = {
    "can_finish": False,
    "can_resend": False,
    "can_cancel": False,
    "can_replace": False,
    "can_reactivate": False,
    "resend_available_at": None,
    "cancel_available_at": None,
    "replace_available_at": None,
}

V2_REACTIVATE_OK = {
    "success": True,
    "data": {
        "orders": [
            {
                "id": 90211,
                "status": "ACTIVE",
                "product_id": 1024,
                "catalog_product_id": 88,
                "amount": {
                    "amount": "0.0077",
                    "currency": "USD",
                    "canonical_amount": 139,
                    "canonical_currency": "IDR",
                },
                **FRESH_CAPS,
            }
        ],
        "failed_count": 0,
    },
    "meta": {"fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None}},
}

V1_REACTIVATE_OK = {
    "success": True,
    "data": {
        "orders": [
            {
                "id": 90211,
                "status": "ACTIVE",
                "product_id": 1024,
                "amount": 139,
                **FRESH_CAPS,
            }
        ],
        "failed_count": 0,
    },
}

V2_OPTIONS_OK = {
    "success": True,
    "data": {
        "cost": {
            "amount": "0.0077",
            "currency": "USD",
            "canonical_amount": 139,
            "canonical_currency": "IDR",
        }
    },
    "meta": {"fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None}},
}

V1_OPTIONS_OK = {"success": True, "data": {"cost": 139}}


def test_v2_reactivate_sends_key_and_decodes_money() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.post("/v2/orders/reactivate").respond(200, json=V2_REACTIVATE_OK)
        with SmscodeClient(token="tok") as client:
            result = client.orders.reactivate(90210, max_price="0.75", idempotency_key="react-key")

    assert route.calls[0].request.headers["idempotency-key"] == "react-key"
    assert route.calls[0].request.content == b'{"id":90210,"max_price":"0.75"}'
    assert result.idempotency_key == "react-key"
    assert isinstance(result.orders[0], CreatedOrder)
    assert result.orders[0]["id"] == 90211
    assert result.orders[0].amount == Money(
        amount="0.0077",
        currency="USD",
        canonical_amount=139,
        canonical_currency="IDR",
    )
    assert result.fx == V2Fx(pair="USD/IDR", rate=17970, rate_as_of=None)


def test_v2_reactivate_without_max_price_sends_only_id() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.post("/v2/orders/reactivate").respond(200, json=V2_REACTIVATE_OK)
        with SmscodeClient(token="tok") as client:
            result = client.orders.reactivate(90210, idempotency_key="react-key")

    assert route.calls[0].request.content == b'{"id":90210}'
    assert result.idempotency_key == "react-key"


def test_v1_reactivate_returns_idr_shape() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.post("/v1/orders/reactivate").respond(200, json=V1_REACTIVATE_OK)
        with SmscodeClient(token="tok") as client:
            result = client.v1.orders.reactivate(90210, max_price=800000, idempotency_key="v1-key")

    assert route.calls[0].request.content == b'{"id":90210,"max_price":800000}'
    assert route.calls[0].request.headers["idempotency-key"] == "v1-key"
    assert isinstance(result.orders[0], CreatedOrder)
    assert result.orders[0].amount == 139
    assert result.idempotency_key == "v1-key"


def test_reactivate_stamps_idempotency_key_on_error() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.post("/v2/orders/reactivate").respond(
            422,
            json={"success": False, "error": {"code": "IDEMPOTENCY_KEY_REUSED", "message": "x"}},
        )
        with (
            SmscodeClient(token="tok") as client,
            pytest.raises(IdempotencyKeyReuseError) as excinfo,
        ):
            client.orders.reactivate(90210, idempotency_key="stamp-me")

    assert excinfo.value.idempotency_key == "stamp-me"


def test_v2_reactivate_options_returns_money_and_fx() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.get("/v2/orders/90210/reactivate-options").respond(200, json=V2_OPTIONS_OK)
        with SmscodeClient(token="tok") as client:
            preview = client.orders.reactivate_options(90210)

    assert "idempotency-key" not in route.calls[0].request.headers
    assert isinstance(preview, ReactivateOptionsV2)
    assert preview.cost == Money(
        amount="0.0077",
        currency="USD",
        canonical_amount=139,
        canonical_currency="IDR",
    )
    assert preview.fx == V2Fx(pair="USD/IDR", rate=17970, rate_as_of=None)


def test_v1_reactivate_options_returns_idr_int() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.get("/v1/orders/90210/reactivate-options").respond(200, json=V1_OPTIONS_OK)
        with SmscodeClient(token="tok") as client:
            preview = client.v1.orders.reactivate_options(90210)

    assert "idempotency-key" not in route.calls[0].request.headers
    assert isinstance(preview, ReactivateOptions)
    assert preview.cost == 139


def test_reactivated_child_surfaces_can_reactivate_capability() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/orders/1").respond(
            200,
            json={
                "success": True,
                "data": {
                    "id": 1,
                    "status": "COMPLETED",
                    "amount": {
                        "amount": "0.0077",
                        "currency": "USD",
                        "canonical_amount": 139,
                        "canonical_currency": "IDR",
                    },
                    "can_finish": False,
                    "can_resend": False,
                    "can_cancel": False,
                    "can_replace": False,
                    "can_reactivate": True,
                    "resend_available_at": None,
                    "cancel_available_at": None,
                    "replace_available_at": None,
                },
                "meta": {"fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None}},
            },
        )
        with SmscodeClient(token="tok") as client:
            order = client.orders.get(1)

    assert order.capabilities.can_reactivate is True


@pytest.mark.asyncio
async def test_async_v2_reactivate_and_options() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.post("/v2/orders/reactivate").respond(200, json=V2_REACTIVATE_OK)
        router.get("/v2/orders/90210/reactivate-options").respond(200, json=V2_OPTIONS_OK)
        async with AsyncSmscodeClient(token="tok") as client:
            result = await client.orders.reactivate(90210, idempotency_key="async-key")
            preview = await client.orders.reactivate_options(90210)

    assert result.idempotency_key == "async-key"
    amount = result.orders[0].amount
    assert isinstance(amount, Money)
    assert amount.canonical_amount == 139
    assert isinstance(preview, ReactivateOptionsV2)
    assert preview.cost.canonical_amount == 139


@pytest.mark.asyncio
async def test_async_v1_reactivate_and_options() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.post("/v1/orders/reactivate").respond(200, json=V1_REACTIVATE_OK)
        router.get("/v1/orders/90210/reactivate-options").respond(200, json=V1_OPTIONS_OK)
        async with AsyncSmscodeClient(token="tok") as client:
            result = await client.v1.orders.reactivate(90210, idempotency_key="async-v1")
            preview = await client.v1.orders.reactivate_options(90210)

    assert result.orders[0].amount == 139
    assert isinstance(preview, ReactivateOptions)
    assert preview.cost == 139
