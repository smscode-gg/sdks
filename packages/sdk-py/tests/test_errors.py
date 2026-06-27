import pytest

from smscode import (
    InternalError,
    NotFoundError,
    PayloadTooLargeError,
    RateLimitError,
    ServiceUnavailableError,
    SmscodeError,
    UnauthorizedError,
    ValidationError,
    map_error,
)


def test_map_validation_error() -> None:
    err = map_error(
        status=422,
        payload={"success": False, "error": {"code": "VALIDATION_ERROR", "message": "bad"}},
        request_id="req_1",
        retry_after_seconds=None,
    )
    assert isinstance(err, ValidationError)
    assert err.code == "VALIDATION_ERROR"
    assert err.http_status == 422
    assert err.request_id == "req_1"


def test_rate_limit_keeps_retry_after() -> None:
    err = map_error(
        status=429,
        payload={"success": False, "error": {"code": "RATE_LIMIT_EXCEEDED", "message": "slow"}},
        request_id=None,
        retry_after_seconds=2.5,
    )
    assert isinstance(err, RateLimitError)
    assert err.retry_after_seconds == 2.5


def test_unknown_code_falls_back_to_base() -> None:
    err = map_error(
        status=499,
        payload={"success": False, "error": {"code": "NEW_CODE", "message": "new"}},
        request_id="r",
        retry_after_seconds=None,
    )
    assert isinstance(err, SmscodeError)
    assert type(err) is SmscodeError
    assert err.code == "NEW_CODE"


@pytest.mark.parametrize(
    ("status", "expected_type", "expected_code"),
    [
        (401, UnauthorizedError, "UNAUTHORIZED"),
        (404, NotFoundError, "NOT_FOUND"),
        (413, PayloadTooLargeError, "PAYLOAD_TOO_LARGE"),
        (429, RateLimitError, "RATE_LIMIT_EXCEEDED"),
        (500, InternalError, "INTERNAL_ERROR"),
        (503, ServiceUnavailableError, "SERVICE_UNAVAILABLE"),
    ],
)
def test_unstructured_errors_fall_back_to_status(
    status: int,
    expected_type: type[SmscodeError],
    expected_code: str,
) -> None:
    err = map_error(
        status=status,
        payload=None,
        request_id="req_status",
        retry_after_seconds=3.0,
    )
    assert isinstance(err, expected_type)
    assert err.code == expected_code
    assert err.http_status == status
    assert err.request_id == "req_status"
    if status == 429:
        assert err.retry_after_seconds == 3.0


def test_create_errors_can_be_key_stamped_once() -> None:
    err = ValidationError("bad")
    assert err.with_idempotency_key("stable").idempotency_key == "stable"
    assert err.with_idempotency_key("other").idempotency_key == "stable"
