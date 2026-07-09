from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from smscode.errors import InvalidResponseError
from smscode.money import Money


@dataclass(frozen=True)
class V2Fx:
    pair: str
    rate: int | str
    rate_as_of: str | None = None
    source: str | None = None
    as_of: str | None = None


@dataclass(frozen=True)
class ExchangeRate:
    pair: str
    rate: int | str
    base_currency: str | None = None
    quote_currency: str | None = None
    rate_as_of: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


@dataclass(frozen=True)
class Country:
    id: int
    name: str
    code: str | None = None
    dial_code: str | None = None
    emoji: str | None = None
    active: bool = True
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


@dataclass(frozen=True)
class Service:
    id: int
    name: str
    code: str
    active: bool = True
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


@dataclass(frozen=True)
class Operator:
    operator_id: int | None
    code: str
    name: str | None = None
    local_name: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


@dataclass(frozen=True)
class OrderCapabilities:
    can_finish: bool
    can_resend: bool
    can_cancel: bool
    can_replace: bool
    # Server-authoritative reactivation flag (a completed order whose number
    # supports reactivation).
    can_reactivate: bool
    resend_available_at: str | None = None
    cancel_available_at: str | None = None
    replace_available_at: str | None = None


@dataclass(frozen=True)
class Order:
    raw: dict[str, Any]
    capabilities: OrderCapabilities
    amount: Money | int | None = None
    fx: V2Fx | None = None

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


@dataclass(frozen=True)
class CreatedOrder(Order):
    pass


@dataclass(frozen=True)
class FinishResult:
    order_id: int
    status: str
    raw: dict[str, Any]

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]


@dataclass(frozen=True)
class ResendResult:
    order_id: int
    status: str
    raw: dict[str, Any]
    resent: bool | None = None

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]


@dataclass(frozen=True)
class WebhookConfig:
    webhook_url: str | None
    webhook_secret: str | None
    webhook_disabled_at: str | None
    webhook_disabled_reason: str | None
    webhook_consecutive_failures: int
    raw: dict[str, Any]

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]


@dataclass(frozen=True)
class WebhookTestResult:
    status_code: int
    raw: dict[str, Any]

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    @property
    def status(self) -> int:
        return self.status_code


@dataclass(frozen=True)
class BalanceV2:
    balance: Money
    fx: V2Fx


@dataclass(frozen=True)
class BalanceV1:
    balance: int
    currency: str = "IDR"
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


@dataclass(frozen=True)
class Product:
    id: int
    name: str | None
    country_id: int | None
    platform_id: int | None
    available: int
    price: Money | int | None
    active: bool
    catalog_product_id: int | None = None
    operator_id: int | None = None
    operator_name: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


@dataclass(frozen=True)
class ProductV2(Product):
    price: Money


@dataclass(frozen=True)
class ProductsPage:
    products: list[Product]
    page: int | None
    limit: int | None
    count: int | None
    fx: V2Fx | None = None


@dataclass(frozen=True)
class ProductsPageV2(ProductsPage):
    products: list[Product]
    page: int | None
    limit: int | None
    count: int | None
    fx: V2Fx


@dataclass(frozen=True)
class ProductsPageV1(ProductsPage):
    pass


@dataclass(frozen=True)
class OrdersList:
    orders: list[Order]
    fx: V2Fx | None = None


@dataclass(frozen=True)
class OrdersListV2(OrdersList):
    orders: list[Order]
    fx: V2Fx


@dataclass(frozen=True)
class CreateOrderResult:
    orders: list[CreatedOrder]
    failed_count: int
    idempotency_key: str
    fx: V2Fx | None = None


@dataclass(frozen=True)
class CreateOrderResultV2(CreateOrderResult):
    orders: list[CreatedOrder]
    failed_count: int
    idempotency_key: str
    fx: V2Fx


@dataclass(frozen=True)
class CreateOrderResultV1(CreateOrderResult):
    pass


@dataclass(frozen=True)
class CancelResult:
    order_id: int
    status: str
    refund_amount: Money | int
    new_balance: Money | int
    fx: V2Fx | None = None


@dataclass(frozen=True)
class CancelResultV2(CancelResult):
    order_id: int
    status: str
    refund_amount: Money
    new_balance: Money
    fx: V2Fx


@dataclass(frozen=True)
class ReactivateOptions:
    """A read-only reactivation cost preview. ``/v1`` ``cost`` is an IDR int."""

    cost: Money | int
    fx: V2Fx | None = None


@dataclass(frozen=True)
class ReactivateOptionsV2(ReactivateOptions):
    """The ``/v2`` reactivation preview — ``cost`` projected to a USD :class:`Money` + FX."""

    cost: Money
    fx: V2Fx


def parse_v2_fx(value: object) -> V2Fx:
    if not isinstance(value, Mapping):
        raise InvalidResponseError("The /v2 response is missing its FX receipt.")
    pair = value.get("pair")
    rate = value.get("rate")
    rate_as_of = value.get("rate_as_of")
    if not isinstance(pair, str) or not isinstance(rate, (int, str)):
        raise InvalidResponseError("The /v2 response has a malformed FX receipt.")
    if rate_as_of is not None and not isinstance(rate_as_of, str):
        raise InvalidResponseError("The /v2 response has a malformed FX receipt.")
    source = value.get("source")
    as_of = value.get("as_of")
    return V2Fx(
        pair=pair,
        rate=rate,
        rate_as_of=rate_as_of,
        source=source if isinstance(source, str) else None,
        as_of=as_of if isinstance(as_of, str) else None,
    )
