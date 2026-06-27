import pytest

from smscode import ValidationError, is_valid_idempotency_key, resolve_idempotency_key


def test_idempotency_key_contract() -> None:
    assert is_valid_idempotency_key("abc_123-XYZ")
    assert not is_valid_idempotency_key("")
    assert not is_valid_idempotency_key("x" * 129)
    with pytest.raises(ValidationError):
        resolve_idempotency_key("not valid")


def test_generated_key_is_valid() -> None:
    assert is_valid_idempotency_key(resolve_idempotency_key())
