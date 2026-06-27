from __future__ import annotations

from collections.abc import Mapping
from types import TracebackType
from typing import Any

import httpx

from smscode._transport import DEFAULT_BASE_URL, SyncTransport
from smscode.resources import V1CatalogBalanceNamespace, V1CatalogResource, V2CatalogResource
from smscode.resources.balance import V1BalanceResource, V2BalanceResource
from smscode.resources.orders import V1OrdersResource, V2OrdersResource
from smscode.resources.webhook import V1WebhookResource, V2WebhookResource
from smscode.types import ApiResult, HttpMethod, QueryValue


class SmscodeClient:
    def __init__(
        self,
        *,
        token: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout_ms: int = 0,
        max_retries: int = 0,
        client: httpx.Client | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._transport = SyncTransport(
            token=token,
            base_url=base_url,
            timeout_ms=timeout_ms,
            max_retries=max_retries,
            client=client,
            transport=transport,
        )
        self.catalog = V2CatalogResource(self.request)
        self.balance = V2BalanceResource(self.request)
        self.orders = V2OrdersResource(self.request)
        self.webhook = V2WebhookResource(self.request)
        self.v1 = V1CatalogBalanceNamespace(
            catalog=V1CatalogResource(self.request),
            balance=V1BalanceResource(self.request),
            orders=V1OrdersResource(self.request),
            webhook=V1WebhookResource(self.request),
        )

    def __enter__(self) -> SmscodeClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        self._transport.close()

    def request(
        self,
        method: HttpMethod,
        path: str,
        *,
        params: Mapping[str, QueryValue] | None = None,
        json: Any | None = None,
        headers: Mapping[str, str] | None = None,
        retry: int | None = None,
    ) -> ApiResult[Any]:
        return self._transport.request(
            method,
            path,
            params=params,
            json=json,
            headers=headers,
            retry=retry,
        )
