from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeVar, cast

from smscode.errors import (
    InvalidResponseError,
    RequestCancelledError,
    SmscodeError,
)
from smscode.idempotency import resolve_idempotency_key
from smscode.models import (
    CancelResult,
    CancelResultV2,
    CreatedOrder,
    CreateOrderResultV1,
    CreateOrderResultV2,
    FinishResult,
    Order,
    OrderCapabilities,
    OrdersListV2,
    ReactivateOptions,
    ReactivateOptionsV2,
    ResendResult,
    V2Fx,
    parse_v2_fx,
)
from smscode.money import Money, parse_money
from smscode.types import ApiResult, OrderStatus, QueryValue
from smscode.wait import (
    DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_TIMEOUT_MS,
    OtpResult,
    async_wait_for_otp,
    wait_for_otp,
)

SyncRequest = Callable[..., ApiResult[Any]]
AsyncRequest = Callable[..., Awaitable[ApiResult[Any]]]
SyncSleep = Callable[[float], None]
SyncNow = Callable[[], float]
AsyncSleep = Callable[[float], Awaitable[None]]
T = TypeVar("T")
AnyList = list[Any]
OrderList = list[Order]
CreatedOrderList = list[CreatedOrder]
CAPABILITY_BOOL_FIELDS = ("can_finish", "can_resend", "can_cancel", "can_replace", "can_reactivate")
CAPABILITY_TIME_FIELDS = ("resend_available_at", "cancel_available_at", "replace_available_at")


def _orders_params(
    *,
    limit: int | None = None,
    offset: int | None = None,
    status: OrderStatus | None = None,
) -> dict[str, QueryValue]:
    return {"limit": limit, "offset": offset, "status": status}


def _capabilities(raw: Mapping[str, Any], *, label: str) -> OrderCapabilities:
    _validate_capabilities(raw, label=label)
    return OrderCapabilities(
        can_finish=raw["can_finish"],
        can_resend=raw["can_resend"],
        can_cancel=raw["can_cancel"],
        can_replace=raw["can_replace"],
        can_reactivate=raw["can_reactivate"],
        resend_available_at=raw["resend_available_at"],
        cancel_available_at=raw["cancel_available_at"],
        replace_available_at=raw["replace_available_at"],
    )


def _decode_v2_order(raw: object, fx: V2Fx, *, created: bool = False) -> Order:
    if not isinstance(raw, Mapping):
        raise InvalidResponseError("The /v2 order response is malformed.")
    order = dict(raw)
    order["amount"] = parse_money(raw.get("amount"))
    capabilities = _capabilities(raw, label="/v2 order")
    order["fx"] = fx
    model = CreatedOrder if created else Order
    return model(raw=order, capabilities=capabilities, amount=order["amount"], fx=fx)


def _decode_v1_order(raw: object, *, label: str, created: bool = False) -> Order:
    if not isinstance(raw, Mapping):
        raise InvalidResponseError(f"The {label} response is malformed.")
    order = dict(raw)
    capabilities = _capabilities(raw, label=label)
    amount = order.get("amount")
    model = CreatedOrder if created else Order
    return model(
        raw=order,
        capabilities=capabilities,
        amount=amount if isinstance(amount, (int, Money)) else None,
    )


def _decode_v2_orders(raw: object, fx: V2Fx, *, created: bool = False) -> OrderList:
    if not isinstance(raw, list):
        raise InvalidResponseError("The /v2 orders response is malformed.")
    return [_decode_v2_order(item, fx, created=created) for item in raw]


def _decode_v1_orders(raw: object, *, label: str, created: bool = False) -> OrderList:
    if not isinstance(raw, list):
        raise InvalidResponseError(f"The {label} response is malformed.")
    return [_decode_v1_order(item, label=label, created=created) for item in raw]


def _validate_capabilities(raw: Mapping[str, Any], *, label: str) -> None:
    for field in CAPABILITY_BOOL_FIELDS:
        if type(raw.get(field)) is not bool:
            raise InvalidResponseError(f"The {label} response is missing capability field {field}.")
    for field in CAPABILITY_TIME_FIELDS:
        value = raw.get(field)
        if field not in raw or (value is not None and not isinstance(value, str)):
            raise InvalidResponseError(f"The {label} response is missing capability field {field}.")


def _decode_v2_create_result(result: ApiResult[Any], key: str) -> CreateOrderResultV2:
    data = result.data
    if not isinstance(data, Mapping) or not isinstance(data.get("orders"), list):
        raise InvalidResponseError("The /v2 create response is missing its orders array.")
    fx = parse_v2_fx((result.meta or {}).get("fx"))
    return CreateOrderResultV2(
        orders=cast(list[CreatedOrder], _decode_v2_orders(data["orders"], fx, created=True)),
        failed_count=_int_or_zero(data.get("failed_count")),
        idempotency_key=key,
        fx=fx,
    )


def _decode_v1_create_result(result: ApiResult[Any], key: str) -> CreateOrderResultV1:
    data = result.data
    if not isinstance(data, Mapping) or not isinstance(data.get("orders"), list):
        raise InvalidResponseError(
            "The /v1 create response is missing its orders array; the result cannot be trusted."
        )
    return CreateOrderResultV1(
        orders=cast(
            list[CreatedOrder],
            _decode_v1_orders(data["orders"], label="/v1 create", created=True),
        ),
        failed_count=_int_or_zero(data.get("failed_count")),
        idempotency_key=key,
    )


def _decode_v2_cancel_result(result: ApiResult[Any]) -> CancelResultV2:
    data = result.data
    if not isinstance(data, Mapping):
        raise InvalidResponseError("The /v2 cancel response is malformed.")
    order_id = data.get("order_id")
    status = data.get("status")
    if type(order_id) is not int or not isinstance(status, str):
        raise InvalidResponseError("The /v2 cancel response is malformed.")
    fx = parse_v2_fx((result.meta or {}).get("fx"))
    return CancelResultV2(
        order_id=order_id,
        status=status,
        refund_amount=parse_money(data.get("refund_amount")),
        new_balance=parse_money(data.get("new_balance")),
        fx=fx,
    )


def _decode_v1_cancel_result(result: ApiResult[Any]) -> CancelResult:
    data = result.data
    if not isinstance(data, Mapping):
        raise InvalidResponseError("The /v1 cancel response is malformed.")
    order_id = data.get("order_id")
    status = data.get("status")
    refund_amount = data.get("refund_amount")
    new_balance = data.get("new_balance")
    if (
        type(order_id) is not int
        or not isinstance(status, str)
        or type(refund_amount) is not int
        or type(new_balance) is not int
    ):
        raise InvalidResponseError("The /v1 cancel response is malformed.")
    return CancelResult(
        order_id=order_id,
        status=status,
        refund_amount=refund_amount,
        new_balance=new_balance,
    )


def _decode_finish_result(result: ApiResult[Any], *, label: str) -> FinishResult:
    data = result.data
    if not isinstance(data, Mapping):
        raise InvalidResponseError(f"The {label} response is malformed.")
    order_id = data.get("order_id")
    status = data.get("status")
    if type(order_id) is not int or not isinstance(status, str):
        raise InvalidResponseError(f"The {label} response is malformed.")
    return FinishResult(order_id=order_id, status=status, raw=dict(data))


def _decode_resend_result(result: ApiResult[Any], *, label: str) -> ResendResult:
    data = result.data
    if not isinstance(data, Mapping):
        raise InvalidResponseError(f"The {label} response is malformed.")
    order_id = data.get("order_id")
    status = data.get("status")
    resent = data.get("resent")
    if type(order_id) is not int or not isinstance(status, str):
        raise InvalidResponseError(f"The {label} response is malformed.")
    return ResendResult(
        order_id=order_id,
        status=status,
        raw=dict(data),
        resent=resent if type(resent) is bool else None,
    )


def _int_or_zero(value: object) -> int:
    return value if type(value) is int else 0


def _ensure_list(value: object, *, label: str) -> AnyList:
    if not isinstance(value, list):
        raise InvalidResponseError(f"The {label} response is malformed.")
    return value


def _stamp_create_error(err: Exception, key: str) -> Exception:
    if isinstance(err, SmscodeError):
        return err.with_idempotency_key(key)
    return InvalidResponseError("Failed to decode the create response.").with_idempotency_key(key)


def _create_with_idempotency(
    request: SyncRequest,
    path: str,
    body: Mapping[str, Any],
    *,
    idempotency_key: str | None,
    decode: Callable[[ApiResult[Any], str], T],
) -> T:
    key = resolve_idempotency_key(idempotency_key)
    try:
        result = request(
            "POST",
            path,
            json=body,
            headers={"idempotency-key": key},
        )
        return decode(result, key)
    except SmscodeError as err:
        raise err.with_idempotency_key(key) from err
    except Exception as err:
        raise _stamp_create_error(err, key) from err


async def _async_create_with_idempotency(
    request: AsyncRequest,
    path: str,
    body: Mapping[str, Any],
    *,
    idempotency_key: str | None,
    decode: Callable[[ApiResult[Any], str], T],
) -> T:
    key = resolve_idempotency_key(idempotency_key)
    try:
        result = await request(
            "POST",
            path,
            json=body,
            headers={"idempotency-key": key},
        )
        return decode(result, key)
    except asyncio.CancelledError as err:
        raise RequestCancelledError(idempotency_key=key) from err
    except SmscodeError as err:
        raise err.with_idempotency_key(key) from err
    except Exception as err:
        raise _stamp_create_error(err, key) from err


def _mutate_order(request: SyncRequest, path: str, order_id: int) -> ApiResult[Any]:
    return request("POST", path, json={"id": order_id}, retry=0)


async def _async_mutate_order(request: AsyncRequest, path: str, order_id: int) -> ApiResult[Any]:
    return await request("POST", path, json={"id": order_id}, retry=0)


def _create_body(body: Mapping[str, Any] | None, params: Mapping[str, Any]) -> Mapping[str, Any]:
    if body is not None and params:
        raise TypeError("Pass either a create body mapping or keyword parameters, not both.")
    return body if body is not None else dict(params)


def _reactivate_body(order_id: int, max_price: object) -> dict[str, Any]:
    # {id, max_price?} — max_price omitted entirely when None (v2 USD-decimal
    # string / v1 IDR int). The server computes the react:-namespaced fingerprint.
    body: dict[str, Any] = {"id": order_id}
    if max_price is not None:
        body["max_price"] = max_price
    return body


def _decode_v2_reactivate_options(result: ApiResult[Any]) -> ReactivateOptionsV2:
    data = result.data
    if not isinstance(data, Mapping):
        raise InvalidResponseError("The /v2 reactivate-options response is malformed.")
    fx = parse_v2_fx((result.meta or {}).get("fx"))
    return ReactivateOptionsV2(cost=parse_money(data.get("cost")), fx=fx)


def _decode_v1_reactivate_options(result: ApiResult[Any]) -> ReactivateOptions:
    data = result.data
    if not isinstance(data, Mapping) or type(data.get("cost")) is not int:
        raise InvalidResponseError("The /v1 reactivate-options response is malformed.")
    return ReactivateOptions(cost=data["cost"])


class V2OrdersResource:
    def __init__(self, request: SyncRequest) -> None:
        self._request = request

    def create(
        self,
        body: Mapping[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        **params: Any,
    ) -> CreateOrderResultV2:
        return _create_with_idempotency(
            self._request,
            "/v2/orders/create",
            _create_body(body, params),
            idempotency_key=idempotency_key,
            decode=_decode_v2_create_result,
        )

    def get(self, order_id: int) -> Order:
        result = self._request("GET", f"/v2/orders/{order_id}")
        fx = parse_v2_fx((result.meta or {}).get("fx"))
        return _decode_v2_order(result.data, fx)

    def list(
        self,
        *,
        limit: int | None = None,
        offset: int | None = None,
        status: OrderStatus | None = None,
    ) -> OrdersListV2:
        result = self._request(
            "GET",
            "/v2/orders",
            params=_orders_params(limit=limit, offset=offset, status=status),
        )
        fx = parse_v2_fx((result.meta or {}).get("fx"))
        return OrdersListV2(orders=_decode_v2_orders(result.data, fx), fx=fx)

    def active(self) -> OrderList:
        return _decode_v1_orders(
            self._request("GET", "/v2/orders/active").data,
            label="/v2 active orders",
        )

    def cancel(self, order_id: int) -> CancelResultV2:
        return _decode_v2_cancel_result(_mutate_order(self._request, "/v2/orders/cancel", order_id))

    def finish(self, order_id: int) -> FinishResult:
        return _decode_finish_result(
            _mutate_order(self._request, "/v2/orders/finish", order_id),
            label="/v2 finish",
        )

    def resend(self, order_id: int) -> ResendResult:
        return _decode_resend_result(
            _mutate_order(self._request, "/v2/orders/resend", order_id),
            label="/v2 resend",
        )

    def reactivate(
        self,
        order_id: int,
        *,
        max_price: str | None = None,
        idempotency_key: str | None = None,
    ) -> CreateOrderResultV2:
        # MONEY mutation mirroring create's idempotency contract. Returns the
        # SAME create-result shape (the ONE reactivated child, amount → USD Money + fx).
        return _create_with_idempotency(
            self._request,
            "/v2/orders/reactivate",
            _reactivate_body(order_id, max_price),
            idempotency_key=idempotency_key,
            decode=_decode_v2_create_result,
        )

    def reactivate_options(self, order_id: int) -> ReactivateOptionsV2:
        # read-only cost preview (NO idempotency key). cost → USD Money + fx.
        return _decode_v2_reactivate_options(
            self._request("GET", f"/v2/orders/{order_id}/reactivate-options")
        )

    def wait_for_otp(
        self,
        order_id: int,
        *,
        after_code: str | None = None,
        after_revision: int | None = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
        sleep: SyncSleep | None = None,
        now: SyncNow | None = None,
    ) -> OtpResult:
        return wait_for_otp(
            lambda: self._request("GET", f"/v1/orders/{order_id}").data,
            after_code=after_code,
            after_revision=after_revision,
            timeout_ms=timeout_ms,
            poll_interval_ms=poll_interval_ms,
            sleep=sleep,
            now=now,
        )


class V1OrdersResource:
    def __init__(self, request: SyncRequest) -> None:
        self._request = request

    def create(
        self,
        body: Mapping[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        **params: Any,
    ) -> CreateOrderResultV1:
        return _create_with_idempotency(
            self._request,
            "/v1/orders/create",
            _create_body(body, params),
            idempotency_key=idempotency_key,
            decode=_decode_v1_create_result,
        )

    def get(self, order_id: int) -> Order:
        return _decode_v1_order(
            self._request("GET", f"/v1/orders/{order_id}").data,
            label="/v1 order",
        )

    def list(
        self,
        *,
        limit: int | None = None,
        offset: int | None = None,
        status: OrderStatus | None = None,
    ) -> OrderList:
        return _decode_v1_orders(
            self._request(
                "GET",
                "/v1/orders",
                params=_orders_params(limit=limit, offset=offset, status=status),
            ).data,
            label="/v1 orders",
        )

    def active(self) -> OrderList:
        return _decode_v1_orders(
            self._request("GET", "/v1/orders/active").data,
            label="/v1 active orders",
        )

    def cancel(self, order_id: int) -> CancelResult:
        return _decode_v1_cancel_result(_mutate_order(self._request, "/v1/orders/cancel", order_id))

    def finish(self, order_id: int) -> FinishResult:
        return _decode_finish_result(
            _mutate_order(self._request, "/v1/orders/finish", order_id),
            label="/v1 finish",
        )

    def resend(self, order_id: int) -> ResendResult:
        return _decode_resend_result(
            _mutate_order(self._request, "/v1/orders/resend", order_id),
            label="/v1 resend",
        )

    def reactivate(
        self,
        order_id: int,
        *,
        max_price: int | None = None,
        idempotency_key: str | None = None,
    ) -> CreateOrderResultV1:
        # MONEY mutation mirroring create's idempotency contract; IDR verbatim.
        return _create_with_idempotency(
            self._request,
            "/v1/orders/reactivate",
            _reactivate_body(order_id, max_price),
            idempotency_key=idempotency_key,
            decode=_decode_v1_create_result,
        )

    def reactivate_options(self, order_id: int) -> ReactivateOptions:
        # read-only cost preview (NO idempotency key). IDR integer cost.
        return _decode_v1_reactivate_options(
            self._request("GET", f"/v1/orders/{order_id}/reactivate-options")
        )

    def wait_for_otp(
        self,
        order_id: int,
        *,
        after_code: str | None = None,
        after_revision: int | None = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
        sleep: SyncSleep | None = None,
        now: SyncNow | None = None,
    ) -> OtpResult:
        return wait_for_otp(
            lambda: self.get(order_id),
            after_code=after_code,
            after_revision=after_revision,
            timeout_ms=timeout_ms,
            poll_interval_ms=poll_interval_ms,
            sleep=sleep,
            now=now,
        )


class AsyncV2OrdersResource:
    def __init__(self, request: AsyncRequest) -> None:
        self._request = request

    async def create(
        self,
        body: Mapping[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        **params: Any,
    ) -> CreateOrderResultV2:
        return await _async_create_with_idempotency(
            self._request,
            "/v2/orders/create",
            _create_body(body, params),
            idempotency_key=idempotency_key,
            decode=_decode_v2_create_result,
        )

    async def get(self, order_id: int) -> Order:
        result = await self._request("GET", f"/v2/orders/{order_id}")
        fx = parse_v2_fx((result.meta or {}).get("fx"))
        return _decode_v2_order(result.data, fx)

    async def list(
        self,
        *,
        limit: int | None = None,
        offset: int | None = None,
        status: OrderStatus | None = None,
    ) -> OrdersListV2:
        result = await self._request(
            "GET",
            "/v2/orders",
            params=_orders_params(limit=limit, offset=offset, status=status),
        )
        fx = parse_v2_fx((result.meta or {}).get("fx"))
        return OrdersListV2(orders=_decode_v2_orders(result.data, fx), fx=fx)

    async def active(self) -> OrderList:
        return _decode_v1_orders(
            (await self._request("GET", "/v2/orders/active")).data,
            label="/v2 active orders",
        )

    async def cancel(self, order_id: int) -> CancelResultV2:
        return _decode_v2_cancel_result(
            await _async_mutate_order(self._request, "/v2/orders/cancel", order_id)
        )

    async def finish(self, order_id: int) -> FinishResult:
        return _decode_finish_result(
            await _async_mutate_order(self._request, "/v2/orders/finish", order_id),
            label="/v2 finish",
        )

    async def resend(self, order_id: int) -> ResendResult:
        return _decode_resend_result(
            await _async_mutate_order(self._request, "/v2/orders/resend", order_id),
            label="/v2 resend",
        )

    async def reactivate(
        self,
        order_id: int,
        *,
        max_price: str | None = None,
        idempotency_key: str | None = None,
    ) -> CreateOrderResultV2:
        return await _async_create_with_idempotency(
            self._request,
            "/v2/orders/reactivate",
            _reactivate_body(order_id, max_price),
            idempotency_key=idempotency_key,
            decode=_decode_v2_create_result,
        )

    async def reactivate_options(self, order_id: int) -> ReactivateOptionsV2:
        return _decode_v2_reactivate_options(
            await self._request("GET", f"/v2/orders/{order_id}/reactivate-options")
        )

    async def wait_for_otp(
        self,
        order_id: int,
        *,
        after_code: str | None = None,
        after_revision: int | None = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
        sleep: AsyncSleep | None = None,
        now: SyncNow | None = None,
    ) -> OtpResult:
        async def poll() -> Any:
            return (await self._request("GET", f"/v1/orders/{order_id}")).data

        return await async_wait_for_otp(
            poll,
            after_code=after_code,
            after_revision=after_revision,
            timeout_ms=timeout_ms,
            poll_interval_ms=poll_interval_ms,
            sleep=sleep,
            now=now,
        )


class AsyncV1OrdersResource:
    def __init__(self, request: AsyncRequest) -> None:
        self._request = request

    async def create(
        self,
        body: Mapping[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        **params: Any,
    ) -> CreateOrderResultV1:
        return await _async_create_with_idempotency(
            self._request,
            "/v1/orders/create",
            _create_body(body, params),
            idempotency_key=idempotency_key,
            decode=_decode_v1_create_result,
        )

    async def get(self, order_id: int) -> Order:
        return _decode_v1_order(
            (await self._request("GET", f"/v1/orders/{order_id}")).data,
            label="/v1 order",
        )

    async def list(
        self,
        *,
        limit: int | None = None,
        offset: int | None = None,
        status: OrderStatus | None = None,
    ) -> OrderList:
        return _decode_v1_orders(
            (
                await self._request(
                    "GET",
                    "/v1/orders",
                    params=_orders_params(limit=limit, offset=offset, status=status),
                )
            ).data,
            label="/v1 orders",
        )

    async def active(self) -> OrderList:
        return _decode_v1_orders(
            (await self._request("GET", "/v1/orders/active")).data,
            label="/v1 active orders",
        )

    async def cancel(self, order_id: int) -> CancelResult:
        return _decode_v1_cancel_result(
            await _async_mutate_order(self._request, "/v1/orders/cancel", order_id)
        )

    async def finish(self, order_id: int) -> FinishResult:
        return _decode_finish_result(
            await _async_mutate_order(self._request, "/v1/orders/finish", order_id),
            label="/v1 finish",
        )

    async def resend(self, order_id: int) -> ResendResult:
        return _decode_resend_result(
            await _async_mutate_order(self._request, "/v1/orders/resend", order_id),
            label="/v1 resend",
        )

    async def reactivate(
        self,
        order_id: int,
        *,
        max_price: int | None = None,
        idempotency_key: str | None = None,
    ) -> CreateOrderResultV1:
        return await _async_create_with_idempotency(
            self._request,
            "/v1/orders/reactivate",
            _reactivate_body(order_id, max_price),
            idempotency_key=idempotency_key,
            decode=_decode_v1_create_result,
        )

    async def reactivate_options(self, order_id: int) -> ReactivateOptions:
        return _decode_v1_reactivate_options(
            await self._request("GET", f"/v1/orders/{order_id}/reactivate-options")
        )

    async def wait_for_otp(
        self,
        order_id: int,
        *,
        after_code: str | None = None,
        after_revision: int | None = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
        sleep: AsyncSleep | None = None,
        now: SyncNow | None = None,
    ) -> OtpResult:
        return await async_wait_for_otp(
            lambda: self.get(order_id),
            after_code=after_code,
            after_revision=after_revision,
            timeout_ms=timeout_ms,
            poll_interval_ms=poll_interval_ms,
            sleep=sleep,
            now=now,
        )
