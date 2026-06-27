import pytest
import respx

from smscode import AsyncSmscodeClient, BalanceV1, Money, SmscodeClient


def test_balance_v2_decodes_money_and_fx() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/balance").respond(
            200,
            json={
                "success": True,
                "data": {
                    "balance": {
                        "amount": "28.78",
                        "currency": "USD",
                        "canonical_amount": 517231,
                        "canonical_currency": "IDR",
                    }
                },
                "meta": {"fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None}},
            },
        )
        with SmscodeClient(token="tok") as client:
            result = client.balance.get()

    assert result.balance == Money(
        amount="28.78",
        currency="USD",
        canonical_amount=517231,
        canonical_currency="IDR",
    )
    assert result.fx.pair == "USD/IDR"


def test_balance_v1_returns_canonical_integer() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v1/balance").respond(
            200,
            json={"success": True, "data": {"currency": "IDR", "balance": 517231}},
        )
        with SmscodeClient(token="tok") as client:
            result = client.v1.balance.get()

    assert result == BalanceV1(balance=517231, currency="IDR")
    assert result["balance"] == 517231


@pytest.mark.asyncio
async def test_async_balance_v2_decodes_money() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/balance").respond(
            200,
            json={
                "success": True,
                "data": {
                    "balance": {
                        "amount": "28.78",
                        "currency": "USD",
                        "canonical_amount": 517231,
                        "canonical_currency": "IDR",
                    }
                },
                "meta": {"fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None}},
            },
        )
        async with AsyncSmscodeClient(token="tok") as client:
            result = await client.balance.get()

    assert result.balance.canonical_amount == 517231
