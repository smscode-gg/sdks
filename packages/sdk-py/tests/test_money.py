import pytest

from smscode import InvalidMoneyError, Money, parse_money


def test_parse_money_keeps_display_amount_as_string() -> None:
    money = parse_money(
        {
            "amount": "0.0077",
            "currency": "USD",
            "canonical_amount": 139,
            "canonical_currency": "IDR",
        }
    )
    assert money == Money(
        amount="0.0077",
        currency="USD",
        canonical_amount=139,
        canonical_currency="IDR",
    )


def test_parse_money_rejects_missing_value() -> None:
    with pytest.raises(InvalidMoneyError):
        parse_money(None)
