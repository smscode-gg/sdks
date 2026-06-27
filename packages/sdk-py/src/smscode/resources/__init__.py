from __future__ import annotations

from dataclasses import dataclass

from smscode.resources.balance import (
    AsyncV1BalanceResource,
    AsyncV2BalanceResource,
    V1BalanceResource,
    V2BalanceResource,
)
from smscode.resources.catalog import (
    AsyncV1CatalogResource,
    AsyncV2CatalogResource,
    V1CatalogResource,
    V2CatalogResource,
)
from smscode.resources.orders import (
    AsyncV1OrdersResource,
    AsyncV2OrdersResource,
    V1OrdersResource,
    V2OrdersResource,
)
from smscode.resources.webhook import (
    AsyncV1WebhookResource,
    AsyncV2WebhookResource,
    V1WebhookResource,
    V2WebhookResource,
)


@dataclass(frozen=True)
class V1CatalogBalanceNamespace:
    catalog: V1CatalogResource
    balance: V1BalanceResource
    orders: V1OrdersResource
    webhook: V1WebhookResource


@dataclass(frozen=True)
class AsyncV1CatalogBalanceNamespace:
    catalog: AsyncV1CatalogResource
    balance: AsyncV1BalanceResource
    orders: AsyncV1OrdersResource
    webhook: AsyncV1WebhookResource


__all__ = [
    "AsyncV1BalanceResource",
    "AsyncV1CatalogBalanceNamespace",
    "AsyncV1CatalogResource",
    "AsyncV1OrdersResource",
    "AsyncV1WebhookResource",
    "AsyncV2BalanceResource",
    "AsyncV2CatalogResource",
    "AsyncV2OrdersResource",
    "AsyncV2WebhookResource",
    "V1BalanceResource",
    "V1CatalogBalanceNamespace",
    "V1CatalogResource",
    "V1OrdersResource",
    "V1WebhookResource",
    "V2BalanceResource",
    "V2CatalogResource",
    "V2OrdersResource",
    "V2WebhookResource",
]
