import pytest
import respx

from smscode import Money, SmscodeClient
from smscode.models import Country, ExchangeRate, ProductV2, Service, V2Fx


def test_catalog_countries_and_services_decode_to_models() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/catalog/countries").respond(
            200,
            json={
                "success": True,
                "data": [
                    {
                        "id": 7,
                        "name": "Indonesia",
                        "code": "id",
                        "dial_code": "62",
                        "emoji": "ID",
                        "active": True,
                    }
                ],
            },
        )
        router.get("/v1/catalog/services", params={"country_id": "7"}).respond(
            200,
            json={
                "success": True,
                "data": [{"id": 1, "name": "WhatsApp", "code": "wa", "active": True}],
            },
        )
        with SmscodeClient(token="tok") as client:
            countries = client.catalog.countries()
            services = client.v1.catalog.services(country_id=7)

    assert countries == [
        Country(
            id=7,
            name="Indonesia",
            code="id",
            dial_code="62",
            emoji="ID",
            active=True,
        )
    ]
    assert countries[0]["name"] == "Indonesia"
    assert services == [Service(id=1, name="WhatsApp", code="wa", active=True)]
    assert services[0]["code"] == "wa"


def test_v2_products_forwards_filters_and_decodes_money_fx() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.get(
            "/v2/catalog/products",
            params={
                "country_id": "7",
                "platform_id": "1",
                "limit": "10",
                "page": "2",
                "sort": "price_asc",
            },
        ).respond(
            200,
            json={
                "success": True,
                "data": [
                    {
                        "id": 10,
                        "name": "WhatsApp Indonesia",
                        "country_id": 7,
                        "platform_id": 1,
                        "available": 5,
                        "price": {
                            "amount": "0.0077",
                            "currency": "USD",
                            "canonical_amount": 139,
                            "canonical_currency": "IDR",
                        },
                        "active": True,
                    }
                ],
                "meta": {
                    "page": 2,
                    "limit": 10,
                    "count": 1,
                    "fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None},
                },
            },
        )
        with SmscodeClient(token="tok") as client:
            page = client.catalog.products(
                country_id=7,
                platform_id=1,
                limit=10,
                page=2,
                sort="price_asc",
            )

    assert route.called
    assert page.fx.pair == "USD/IDR"
    assert page.products == [
        ProductV2(
            id=10,
            name="WhatsApp Indonesia",
            country_id=7,
            platform_id=1,
            available=5,
            price=Money(
                amount="0.0077",
                currency="USD",
                canonical_amount=139,
                canonical_currency="IDR",
            ),
            active=True,
            catalog_product_id=None,
        )
    ]


def test_v1_products_return_idr_shape_without_money_projection() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v1/catalog/products", params={"sort": "price_asc"}).respond(
            200,
            json={
                "success": True,
                "data": [{"id": 10, "price": 139, "available": 5, "active": True}],
                "meta": {"page": 1, "limit": 1000, "count": 1},
            },
        )
        with SmscodeClient(token="tok") as client:
            page = client.v1.catalog.products(sort="price_asc")

    assert page.products[0]["price"] == 139


@pytest.mark.asyncio
async def test_async_catalog_products_mirrors_sync() -> None:
    from smscode import AsyncSmscodeClient

    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/catalog/products").respond(
            200,
            json={
                "success": True,
                "data": [],
                "meta": {
                    "page": 1,
                    "limit": 1000,
                    "count": 0,
                    "fx": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": None},
                },
            },
        )
        async with AsyncSmscodeClient(token="tok") as client:
            page = await client.catalog.products()

    assert page.products == []
    assert page.fx.rate == 17970


def test_exchange_rate_surfaces_return_typed_models() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/catalog/exchange-rate", params={"pair": "USD/IDR"}).respond(
            200,
            json={
                "success": True,
                "data": {"pair": "USD/IDR", "rate": 17970, "rate_as_of": "2026-06-27T00:00:00Z"},
            },
        )
        router.get("/v1/catalog/exchange-rate").respond(
            200,
            json={
                "success": True,
                "data": {
                    "pair": "USD/IDR",
                    "base_currency": "USD",
                    "quote_currency": "IDR",
                    "rate": 17970,
                },
            },
        )
        with SmscodeClient(token="tok") as client:
            v2_rate = client.catalog.exchange_rate(pair="USD/IDR")
            v1_rate = client.v1.catalog.exchange_rate()

    assert isinstance(v2_rate, V2Fx)
    assert v2_rate.pair == "USD/IDR"
    assert isinstance(v1_rate, ExchangeRate)
    assert v1_rate.base_currency == "USD"
    assert v1_rate["rate"] == 17970
