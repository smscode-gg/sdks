from __future__ import annotations

from collections.abc import Mapping
from types import TracebackType
from typing import Any

import httpx

from smscode._async_transport import AsyncTransport
from smscode._transport import DEFAULT_BASE_URL
from smscode.resources import (
    AsyncV1CatalogBalanceNamespace,
    AsyncV1CatalogResource,
    AsyncV2CatalogResource,
)
from smscode.resources.balance import AsyncV1BalanceResource, AsyncV2BalanceResource
from smscode.resources.orders import AsyncV1OrdersResource, AsyncV2OrdersResource
from smscode.resources.webhook import AsyncV1WebhookResource, AsyncV2WebhookResource
from smscode.types import ApiResult, HttpMethod, QueryValue


class AsyncSmscodeClient:
    def __init__(
        self,
        *,
        token: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout_ms: int = 0,
        max_retries: int = 0,
        client: httpx.AsyncClient | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._transport = AsyncTransport(
            token=token,
            base_url=base_url,
            timeout_ms=timeout_ms,
            max_retries=max_retries,
            client=client,
            transport=transport,
        )
        self.catalog = AsyncV2CatalogResource(self.request)
        self.balance = AsyncV2BalanceResource(self.request)
        self.orders = AsyncV2OrdersResource(self.request)
        self.webhook = AsyncV2WebhookResource(self.request)
        self.v1 = AsyncV1CatalogBalanceNamespace(
            catalog=AsyncV1CatalogResource(self.request),
            balance=AsyncV1BalanceResource(self.request),
            orders=AsyncV1OrdersResource(self.request),
            webhook=AsyncV1WebhookResource(self.request),
        )

    async def __aenter__(self) -> AsyncSmscodeClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._transport.aclose()

    async def request(
        self,
        method: HttpMethod,
        path: str,
        *,
        params: Mapping[str, QueryValue] | None = None,
        json: Any | None = None,
        headers: Mapping[str, str] | None = None,
        retry: int | None = None,
    ) -> ApiResult[Any]:
        return await self._transport.request(
            method,
            path,
            params=params,
            json=json,
            headers=headers,
            retry=retry,
        )
