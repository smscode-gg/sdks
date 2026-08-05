from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from smscode.errors import OrderTerminalError, OtpTimeoutError, RateLimitError

TERMINAL_STATUSES = {"COMPLETED", "CANCELED", "EXPIRED"}
DEFAULT_POLL_INTERVAL_MS = 3000
DEFAULT_TIMEOUT_MS = 20 * 60 * 1000


@dataclass(frozen=True)
class OtpResult:
    otp_code: str
    status: str
    order: Any


def wait_for_otp(
    poll_order: Callable[[], Any],
    *,
    after_code: str | None = None,
    after_revision: int | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
    sleep: Callable[[float], None] | None = None,
    now: Callable[[], float] | None = None,
) -> OtpResult:
    """Wait for a classified code, not merely for SMS delivery.

    An order may have a non-null ``otp_message`` and a null ``otp_code``. This
    helper keeps polling in that state. A timeout or terminal error therefore
    does not prove refund eligibility; fetch the order and gate cancellation on
    its server-authoritative ``can_cancel`` capability. After a resend, pair
    ``after_code`` with ``after_revision`` so an identical-code or no-code
    follow-up can be distinguished from the preserved aggregate code.
    """
    sleep_fn = sleep or time.sleep
    now_fn = now or (lambda: time.monotonic() * 1000)
    deadline = now_fn() + timeout_ms

    while True:
        try:
            order = poll_order()
        except RateLimitError as err:
            delay_seconds = (
                err.retry_after_seconds
                if err.retry_after_seconds is not None
                else poll_interval_ms / 1000
            )
            if now_fn() + delay_seconds * 1000 > deadline:
                raise OtpTimeoutError("Timed out waiting for OTP.") from err
            sleep_fn(delay_seconds)
            continue

        result = _result_or_error(
            order,
            after_code=after_code,
            after_revision=after_revision,
        )
        if result is not None:
            return result
        status = _status(order)
        if status in TERMINAL_STATUSES:
            raise OrderTerminalError(f"Order reached terminal status {status} before OTP arrived.")
        if now_fn() + poll_interval_ms > deadline:
            raise OtpTimeoutError("Timed out waiting for OTP.")
        sleep_fn(poll_interval_ms / 1000)


async def async_wait_for_otp(
    poll_order: Callable[[], Awaitable[Any]],
    *,
    after_code: str | None = None,
    after_revision: int | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
    sleep: Callable[[float], Awaitable[None]] | None = None,
    now: Callable[[], float] | None = None,
) -> OtpResult:
    """Async equivalent of :func:`wait_for_otp` with the same code-only semantics."""
    sleep_fn = sleep or asyncio.sleep
    now_fn = now or (lambda: time.monotonic() * 1000)
    deadline = now_fn() + timeout_ms

    while True:
        try:
            order = await poll_order()
        except RateLimitError as err:
            delay_seconds = (
                err.retry_after_seconds
                if err.retry_after_seconds is not None
                else poll_interval_ms / 1000
            )
            if now_fn() + delay_seconds * 1000 > deadline:
                raise OtpTimeoutError("Timed out waiting for OTP.") from err
            await sleep_fn(delay_seconds)
            continue

        result = _result_or_error(
            order,
            after_code=after_code,
            after_revision=after_revision,
        )
        if result is not None:
            return result
        status = _status(order)
        if status in TERMINAL_STATUSES:
            raise OrderTerminalError(f"Order reached terminal status {status} before OTP arrived.")
        if now_fn() + poll_interval_ms > deadline:
            raise OtpTimeoutError("Timed out waiting for OTP.")
        await sleep_fn(poll_interval_ms / 1000)


def _result_or_error(
    order: Any,
    *,
    after_code: str | None,
    after_revision: int | None,
) -> OtpResult | None:
    code = _otp_code(order)
    revision = _sms_revision(order)
    code_changed = after_code is not None and code != after_code
    revision_advanced = (
        after_revision is not None and revision is not None and revision > after_revision
    )
    has_baseline = after_code is not None or after_revision is not None
    if code is not None and code != "" and (not has_baseline or code_changed or revision_advanced):
        return OtpResult(otp_code=code, status=_status(order), order=order)
    return None


def _otp_code(order: Any) -> str | None:
    value = _field(order, "otp_code")
    return value if isinstance(value, str) else None


def _sms_revision(order: Any) -> int | None:
    value = _field(order, "sms_revision")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _status(order: Any) -> str:
    value = _field(order, "status")
    return value if isinstance(value, str) else ""


def _field(order: Any, name: str) -> object:
    if isinstance(order, Mapping):
        return order.get(name)
    value = getattr(order, name, None)
    if value is not None:
        return value
    getter = getattr(order, "get", None)
    if callable(getter):
        return getter(name)
    return None
