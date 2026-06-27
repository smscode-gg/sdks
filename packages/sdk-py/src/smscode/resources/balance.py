from __future__ import annotations

from typing import Any

from smscode.models import BalanceV1, BalanceV2, parse_v2_fx
from smscode.money import parse_money


def _decode_v2_balance(result: Any) -> BalanceV2:
    return BalanceV2(balance=parse_money(result.data["balance"]), fx=parse_v2_fx(result.meta["fx"]))


def _decode_v1_balance(result: Any) -> BalanceV1:
    data = result.data
    currency = data.get("currency") if isinstance(data, dict) else None
    return BalanceV1(
        balance=int(data["balance"]),
        currency=currency if isinstance(currency, str) else "IDR",
        raw=dict(data),
    )


class V2BalanceResource:
    def __init__(self, request: Any) -> None:
        self._request = request

    def get(self) -> BalanceV2:
        return _decode_v2_balance(self._request("GET", "/v2/balance"))


class V1BalanceResource:
    def __init__(self, request: Any) -> None:
        self._request = request

    def get(self) -> BalanceV1:
        return _decode_v1_balance(self._request("GET", "/v1/balance"))


class AsyncV2BalanceResource:
    def __init__(self, request: Any) -> None:
        self._request = request

    async def get(self) -> BalanceV2:
        return _decode_v2_balance(await self._request("GET", "/v2/balance"))


class AsyncV1BalanceResource:
    def __init__(self, request: Any) -> None:
        self._request = request

    async def get(self) -> BalanceV1:
        return _decode_v1_balance(await self._request("GET", "/v1/balance"))
