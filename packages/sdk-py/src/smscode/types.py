from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Generic, Literal, TypeVar

T = TypeVar("T")

QueryValue = str | int | float | bool | None
HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
OrderStatus = Literal["ACTIVE", "OTP_RECEIVED", "COMPLETED", "CANCELED", "EXPIRED"]
SortQuery = Literal[
    "price_asc",
    "price_desc",
    "available_asc",
    "available_desc",
    "name_asc",
    "name_desc",
]


@dataclass(frozen=True)
class RequestOptions:
    params: Mapping[str, QueryValue] | None = None
    json: Any | None = None
    headers: Mapping[str, str] | None = None
    retry: int | None = None


@dataclass(frozen=True)
class ApiResult(Generic[T]):
    data: T
    meta: dict[str, Any] | None
    request_id: str | None
    status: int
