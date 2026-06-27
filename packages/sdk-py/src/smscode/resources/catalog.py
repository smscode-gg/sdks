from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from smscode.errors import InvalidResponseError
from smscode.models import (
    Country,
    ExchangeRate,
    Product,
    ProductsPageV1,
    ProductsPageV2,
    ProductV2,
    Service,
    V2Fx,
    parse_v2_fx,
)
from smscode.money import parse_money
from smscode.types import ApiResult, HttpMethod, QueryValue, SortQuery

SyncRequest = Callable[
    [HttpMethod, str],
    ApiResult[Any],
]
AsyncRequest = Callable[
    [HttpMethod, str],
    Awaitable[ApiResult[Any]],
]


def _products_params(
    *,
    country_id: int | None = None,
    platform_id: int | None = None,
    limit: int | None = None,
    page: int | None = None,
    sort: SortQuery | None = None,
) -> dict[str, QueryValue]:
    return {
        "country_id": country_id,
        "platform_id": platform_id,
        "limit": limit,
        "page": page,
        "sort": sort,
    }


def _services_params(*, country_id: int | None = None) -> dict[str, QueryValue]:
    return {"country_id": country_id}


def _exchange_rate_params(*, pair: str | None = None) -> dict[str, QueryValue]:
    return {"pair": pair}


def _decode_v2_products(result: ApiResult[Any]) -> ProductsPageV2:
    meta = result.meta or {}
    fx = parse_v2_fx(meta.get("fx"))
    products: list[Product] = [
        _decode_v2_product(item) for item in result.data if isinstance(item, Mapping)
    ]
    return ProductsPageV2(
        products=products,
        page=_int_or_none(meta.get("page")),
        limit=_int_or_none(meta.get("limit")),
        count=_int_or_none(meta.get("count")),
        fx=fx,
    )


def _decode_v1_products(result: ApiResult[Any]) -> ProductsPageV1:
    meta = result.meta or {}
    products = [_decode_v1_product(item) for item in result.data if isinstance(item, Mapping)]
    return ProductsPageV1(
        products=products,
        page=_int_or_none(meta.get("page")),
        limit=_int_or_none(meta.get("limit")),
        count=_int_or_none(meta.get("count")),
    )


def _decode_v2_product(item: Mapping[str, Any]) -> ProductV2:
    raw = dict(item)
    return ProductV2(
        id=int(item["id"]),
        name=item.get("name") if isinstance(item.get("name"), str) else None,
        country_id=_int_or_none(item.get("country_id")),
        platform_id=_int_or_none(item.get("platform_id")),
        available=int(item["available"]),
        price=parse_money(item.get("price")),
        active=bool(item["active"]),
        catalog_product_id=_int_or_none(item.get("catalog_product_id")),
        raw=raw,
    )


def _decode_v1_product(item: Mapping[str, Any]) -> Product:
    raw = dict(item)
    return Product(
        id=int(item["id"]),
        name=item.get("name") if isinstance(item.get("name"), str) else None,
        country_id=_int_or_none(item.get("country_id")),
        platform_id=_int_or_none(item.get("platform_id")),
        available=int(item["available"]),
        price=item.get("price") if type(item.get("price")) is int else None,
        active=bool(item["active"]),
        catalog_product_id=_int_or_none(item.get("catalog_product_id")),
        raw=raw,
    )


def _decode_country(item: Mapping[str, Any]) -> Country:
    raw = dict(item)
    return Country(
        id=int(item["id"]),
        name=str(item["name"]),
        code=item.get("code") if isinstance(item.get("code"), str) else None,
        dial_code=item.get("dial_code") if isinstance(item.get("dial_code"), str) else None,
        emoji=item.get("emoji") if isinstance(item.get("emoji"), str) else None,
        active=bool(item.get("active", True)),
        raw=raw,
    )


def _decode_service(item: Mapping[str, Any]) -> Service:
    raw = dict(item)
    return Service(
        id=int(item["id"]),
        name=str(item["name"]),
        code=str(item["code"]),
        active=bool(item.get("active", True)),
        raw=raw,
    )


def _decode_countries(data: object) -> list[Country]:
    return (
        [_decode_country(item) for item in data if isinstance(item, Mapping)]
        if isinstance(data, list)
        else []
    )


def _decode_services(data: object) -> list[Service]:
    return (
        [_decode_service(item) for item in data if isinstance(item, Mapping)]
        if isinstance(data, list)
        else []
    )


def _decode_exchange_rate(data: object) -> ExchangeRate:
    if not isinstance(data, Mapping):
        raise InvalidResponseError("The exchange-rate response is malformed.")
    raw = dict(data)
    return ExchangeRate(
        pair=str(data["pair"]),
        rate=data["rate"] if isinstance(data.get("rate"), (int, str)) else str(data.get("rate")),
        base_currency=data.get("base_currency")
        if isinstance(data.get("base_currency"), str)
        else None,
        quote_currency=data.get("quote_currency")
        if isinstance(data.get("quote_currency"), str)
        else None,
        rate_as_of=data.get("rate_as_of") if isinstance(data.get("rate_as_of"), str) else None,
        raw=raw,
    )


def _int_or_none(value: object) -> int | None:
    return value if type(value) is int else None


class V2CatalogResource:
    def __init__(self, request: Any) -> None:
        self._request = request

    def countries(self) -> list[Country]:
        result = self._request("GET", "/v2/catalog/countries")
        return _decode_countries(result.data)

    def services(self, *, country_id: int | None = None) -> list[Service]:
        result = self._request(
            "GET",
            "/v2/catalog/services",
            params=_services_params(country_id=country_id),
        )
        return _decode_services(result.data)

    def products(
        self,
        *,
        country_id: int | None = None,
        platform_id: int | None = None,
        limit: int | None = None,
        page: int | None = None,
        sort: SortQuery | None = None,
    ) -> ProductsPageV2:
        result = self._request(
            "GET",
            "/v2/catalog/products",
            params=_products_params(
                country_id=country_id,
                platform_id=platform_id,
                limit=limit,
                page=page,
                sort=sort,
            ),
        )
        return _decode_v2_products(result)

    def exchange_rate(self, *, pair: str | None = None) -> V2Fx:
        result = self._request(
            "GET",
            "/v2/catalog/exchange-rate",
            params=_exchange_rate_params(pair=pair),
        )
        return parse_v2_fx(result.data)


class V1CatalogResource:
    def __init__(self, request: Any) -> None:
        self._request = request

    def countries(self) -> list[Country]:
        result = self._request("GET", "/v1/catalog/countries")
        return _decode_countries(result.data)

    def services(self, *, country_id: int | None = None) -> list[Service]:
        result = self._request(
            "GET",
            "/v1/catalog/services",
            params=_services_params(country_id=country_id),
        )
        return _decode_services(result.data)

    def products(
        self,
        *,
        country_id: int | None = None,
        platform_id: int | None = None,
        limit: int | None = None,
        page: int | None = None,
        sort: SortQuery | None = None,
    ) -> ProductsPageV1:
        result = self._request(
            "GET",
            "/v1/catalog/products",
            params=_products_params(
                country_id=country_id,
                platform_id=platform_id,
                limit=limit,
                page=page,
                sort=sort,
            ),
        )
        return _decode_v1_products(result)

    def exchange_rate(self, *, pair: str | None = None) -> ExchangeRate:
        result = self._request(
            "GET",
            "/v1/catalog/exchange-rate",
            params=_exchange_rate_params(pair=pair),
        )
        return _decode_exchange_rate(result.data)


class AsyncV2CatalogResource:
    def __init__(self, request: Any) -> None:
        self._request = request

    async def countries(self) -> list[Country]:
        result = await self._request("GET", "/v2/catalog/countries")
        return _decode_countries(result.data)

    async def services(self, *, country_id: int | None = None) -> list[Service]:
        result = await self._request(
            "GET",
            "/v2/catalog/services",
            params=_services_params(country_id=country_id),
        )
        return _decode_services(result.data)

    async def products(
        self,
        *,
        country_id: int | None = None,
        platform_id: int | None = None,
        limit: int | None = None,
        page: int | None = None,
        sort: SortQuery | None = None,
    ) -> ProductsPageV2:
        result = await self._request(
            "GET",
            "/v2/catalog/products",
            params=_products_params(
                country_id=country_id,
                platform_id=platform_id,
                limit=limit,
                page=page,
                sort=sort,
            ),
        )
        return _decode_v2_products(result)

    async def exchange_rate(self, *, pair: str | None = None) -> V2Fx:
        result = await self._request(
            "GET",
            "/v2/catalog/exchange-rate",
            params=_exchange_rate_params(pair=pair),
        )
        return parse_v2_fx(result.data)


class AsyncV1CatalogResource:
    def __init__(self, request: Any) -> None:
        self._request = request

    async def countries(self) -> list[Country]:
        result = await self._request("GET", "/v1/catalog/countries")
        return _decode_countries(result.data)

    async def services(self, *, country_id: int | None = None) -> list[Service]:
        result = await self._request(
            "GET",
            "/v1/catalog/services",
            params=_services_params(country_id=country_id),
        )
        return _decode_services(result.data)

    async def products(
        self,
        *,
        country_id: int | None = None,
        platform_id: int | None = None,
        limit: int | None = None,
        page: int | None = None,
        sort: SortQuery | None = None,
    ) -> ProductsPageV1:
        result = await self._request(
            "GET",
            "/v1/catalog/products",
            params=_products_params(
                country_id=country_id,
                platform_id=platform_id,
                limit=limit,
                page=page,
                sort=sort,
            ),
        )
        return _decode_v1_products(result)

    async def exchange_rate(self, *, pair: str | None = None) -> ExchangeRate:
        result = await self._request(
            "GET",
            "/v1/catalog/exchange-rate",
            params=_exchange_rate_params(pair=pair),
        )
        return _decode_exchange_rate(result.data)
