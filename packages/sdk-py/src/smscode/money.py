from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from smscode.errors import InvalidMoneyError


@dataclass(frozen=True)
class Money:
    amount: str
    currency: Literal["USD"]
    canonical_amount: int
    canonical_currency: Literal["IDR"]


def parse_money(value: object) -> Money:
    if not isinstance(value, Mapping):
        raise InvalidMoneyError("A money value is missing or malformed in the response.")

    amount = value.get("amount")
    currency = value.get("currency")
    canonical_amount = value.get("canonical_amount")
    canonical_currency = value.get("canonical_currency")

    if (
        not isinstance(amount, str)
        or currency != "USD"
        or type(canonical_amount) is not int
        or canonical_currency != "IDR"
    ):
        raise InvalidMoneyError("A money value is missing or malformed in the response.")

    return Money(
        amount=amount,
        currency="USD",
        canonical_amount=canonical_amount,
        canonical_currency="IDR",
    )


def parse_optional_money(value: object | None) -> Money | None:
    if value is None:
        return None
    return parse_money(value)
