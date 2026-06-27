from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any


class SmscodeError(Exception):
    default_code = "SMSCODE_ERROR"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        http_status: int | None = None,
        details: Any | None = None,
        request_id: str | None = None,
        retry_after_seconds: float | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code or self.default_code
        self.http_status = http_status
        self.details = details
        self.request_id = request_id
        self.retry_after_seconds = retry_after_seconds
        self.idempotency_key = idempotency_key

    def with_idempotency_key(self, key: str) -> SmscodeError:
        if self.idempotency_key is None:
            self.idempotency_key = key
        return self


class UnauthorizedError(SmscodeError):
    default_code = "UNAUTHORIZED"


class ForbiddenError(SmscodeError):
    default_code = "FORBIDDEN"


class NotFoundError(SmscodeError):
    default_code = "NOT_FOUND"


class ValidationError(SmscodeError):
    default_code = "VALIDATION_ERROR"


class ProviderError(SmscodeError):
    default_code = "PROVIDER_ERROR"


class NoOfferAvailableError(SmscodeError):
    default_code = "NO_OFFER_AVAILABLE"


class IdempotencyKeyReuseError(SmscodeError):
    default_code = "IDEMPOTENCY_KEY_REUSED"


class InsufficientBalanceError(SmscodeError):
    default_code = "INSUFFICIENT_BALANCE"


class ConflictError(SmscodeError):
    default_code = "CONFLICT"


class CancelTooEarlyError(SmscodeError):
    default_code = "CANCEL_TOO_EARLY"


class RequestInProgressError(SmscodeError):
    default_code = "REQUEST_IN_PROGRESS"


class RateLimitError(SmscodeError):
    default_code = "RATE_LIMIT_EXCEEDED"


class TempBannedError(SmscodeError):
    default_code = "TEMP_BANNED_ABUSE_GUARD"


class ServiceUnavailableError(SmscodeError):
    default_code = "SERVICE_UNAVAILABLE"


class FxRateUnavailableError(SmscodeError):
    default_code = "FX_RATE_UNAVAILABLE"


class InternalError(SmscodeError):
    default_code = "INTERNAL_ERROR"


class PayloadTooLargeError(SmscodeError):
    default_code = "PAYLOAD_TOO_LARGE"


class NetworkError(SmscodeError):
    default_code = "NETWORK_ERROR"


class TimeoutError(SmscodeError):
    default_code = "TIMEOUT"


class InvalidResponseError(SmscodeError):
    default_code = "INVALID_RESPONSE"


class InvalidMoneyError(SmscodeError):
    default_code = "INVALID_MONEY"


class OtpTimeoutError(SmscodeError):
    default_code = "OTP_TIMEOUT"


class OrderTerminalError(SmscodeError):
    default_code = "ORDER_TERMINAL"


class RequestCancelledError(asyncio.CancelledError):
    code = "REQUEST_CANCELLED"

    def __init__(
        self,
        message: str = "Request cancelled",
        *,
        request_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.http_status: int | None = None
        self.details: Any | None = None
        self.request_id = request_id
        self.retry_after_seconds: float | None = None
        self.idempotency_key = idempotency_key

    def with_idempotency_key(self, key: str) -> RequestCancelledError:
        if self.idempotency_key is None:
            self.idempotency_key = key
        return self


ERROR_BY_CODE: dict[str, type[SmscodeError]] = {
    "UNAUTHORIZED": UnauthorizedError,
    "FORBIDDEN": ForbiddenError,
    "NOT_FOUND": NotFoundError,
    "VALIDATION_ERROR": ValidationError,
    "PROVIDER_ERROR": ProviderError,
    "NO_OFFER_AVAILABLE": NoOfferAvailableError,
    "IDEMPOTENCY_KEY_REUSED": IdempotencyKeyReuseError,
    "INSUFFICIENT_BALANCE": InsufficientBalanceError,
    "CONFLICT": ConflictError,
    "CANCEL_TOO_EARLY": CancelTooEarlyError,
    "REQUEST_IN_PROGRESS": RequestInProgressError,
    "RATE_LIMIT_EXCEEDED": RateLimitError,
    "TEMP_BANNED_ABUSE_GUARD": TempBannedError,
    "SERVICE_UNAVAILABLE": ServiceUnavailableError,
    "FX_RATE_UNAVAILABLE": FxRateUnavailableError,
    "INTERNAL_ERROR": InternalError,
    "PAYLOAD_TOO_LARGE": PayloadTooLargeError,
}

STATUS_FALLBACK: dict[int, tuple[str, type[SmscodeError], str]] = {
    401: ("UNAUTHORIZED", UnauthorizedError, "Unauthorized"),
    402: ("INSUFFICIENT_BALANCE", InsufficientBalanceError, "Insufficient balance"),
    403: ("FORBIDDEN", ForbiddenError, "Forbidden"),
    404: ("NOT_FOUND", NotFoundError, "Not found"),
    409: ("CONFLICT", ConflictError, "Conflict"),
    413: ("PAYLOAD_TOO_LARGE", PayloadTooLargeError, "Payload too large"),
    422: ("VALIDATION_ERROR", ValidationError, "Validation error"),
    429: ("RATE_LIMIT_EXCEEDED", RateLimitError, "Rate limit exceeded"),
    500: ("INTERNAL_ERROR", InternalError, "Internal server error"),
    503: ("SERVICE_UNAVAILABLE", ServiceUnavailableError, "Service unavailable"),
}


def map_error(
    *,
    status: int,
    payload: Mapping[str, Any] | None,
    request_id: str | None,
    retry_after_seconds: float | None,
) -> SmscodeError:
    error = payload.get("error") if isinstance(payload, Mapping) else None
    if isinstance(error, Mapping):
        code = error.get("code")
        message = error.get("message")
        details = error.get("details")
    else:
        code = None
        message = None
        details = None

    if isinstance(code, str) and code:
        normalized_code = code
        error_cls = ERROR_BY_CODE.get(normalized_code, SmscodeError)
        normalized_message = (
            message if isinstance(message, str) and message else "SMSCode API error"
        )
    else:
        normalized_code, error_cls, fallback_message = STATUS_FALLBACK.get(
            status,
            ("UNKNOWN_ERROR", SmscodeError, "SMSCode API error"),
        )
        normalized_message = message if isinstance(message, str) and message else fallback_message

    return error_cls(
        normalized_message,
        code=normalized_code,
        http_status=status,
        details=details,
        request_id=request_id,
        retry_after_seconds=retry_after_seconds,
    )
