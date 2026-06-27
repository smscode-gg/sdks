from collections.abc import Iterator

import pytest

from smscode import (
    Order,
    OrderCapabilities,
    OrderTerminalError,
    OtpTimeoutError,
    RateLimitError,
    async_wait_for_otp,
    wait_for_otp,
)


def test_first_otp_resolves() -> None:
    snapshots: Iterator[dict[str, str | None]] = iter(
        [
            {"status": "ACTIVE", "otp_code": None},
            {"status": "OTP_RECEIVED", "otp_code": "123456"},
        ]
    )
    now_ms = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now_ms
        now_ms += seconds * 1000

    result = wait_for_otp(lambda: next(snapshots), sleep=sleep, now=lambda: now_ms)

    assert result.otp_code == "123456"
    assert result.status == "OTP_RECEIVED"


def test_order_model_otp_resolves() -> None:
    order = Order(
        raw={"status": "OTP_RECEIVED", "otp_code": "123456"},
        capabilities=OrderCapabilities(
            can_finish=True,
            can_resend=True,
            can_cancel=False,
            can_replace=False,
        ),
    )

    result = wait_for_otp(
        lambda: order,
        timeout_ms=1,
        poll_interval_ms=3000,
        sleep=lambda seconds: None,
        now=lambda: 0.0,
    )

    assert result.otp_code == "123456"
    assert result.status == "OTP_RECEIVED"
    assert result.order is order


def test_after_code_ignores_stale_and_resolves_changed_code() -> None:
    snapshots: Iterator[dict[str, str | None]] = iter(
        [
            {"status": "OTP_RECEIVED", "otp_code": "111111"},
            {"status": "OTP_RECEIVED", "otp_code": "222222"},
        ]
    )
    now_ms = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now_ms
        now_ms += seconds * 1000

    result = wait_for_otp(
        lambda: next(snapshots),
        after_code="111111",
        sleep=sleep,
        now=lambda: now_ms,
    )

    assert result.otp_code == "222222"


def test_terminal_status_without_usable_otp_raises() -> None:
    with pytest.raises(OrderTerminalError):
        wait_for_otp(
            lambda: {"status": "EXPIRED", "otp_code": None},
            sleep=lambda seconds: None,
            now=lambda: 0.0,
        )


def test_timeout_raises() -> None:
    now_ms = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now_ms
        now_ms += seconds * 1000

    with pytest.raises(OtpTimeoutError):
        wait_for_otp(
            lambda: {"status": "ACTIVE", "otp_code": None},
            timeout_ms=3000,
            poll_interval_ms=3000,
            sleep=sleep,
            now=lambda: now_ms,
        )


def test_rate_limit_honors_retry_after_seconds() -> None:
    waits: list[float] = []
    calls = 0
    now_ms = 0.0

    def poll() -> dict[str, str | None]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RateLimitError("slow", retry_after_seconds=2.0)
        return {"status": "OTP_RECEIVED", "otp_code": "123456"}

    def sleep(seconds: float) -> None:
        nonlocal now_ms
        waits.append(seconds)
        now_ms += seconds * 1000

    result = wait_for_otp(poll, sleep=sleep, now=lambda: now_ms)

    assert result.otp_code == "123456"
    assert waits == [2.0]


@pytest.mark.asyncio
async def test_async_wait_for_otp_mirrors_sync() -> None:
    snapshots: Iterator[dict[str, str | None]] = iter(
        [
            {"status": "ACTIVE", "otp_code": None},
            {"status": "OTP_RECEIVED", "otp_code": "123456"},
        ]
    )
    now_ms = 0.0

    async def poll() -> dict[str, str | None]:
        return next(snapshots)

    async def sleep(seconds: float) -> None:
        nonlocal now_ms
        now_ms += seconds * 1000

    result = await async_wait_for_otp(poll, sleep=sleep, now=lambda: now_ms)

    assert result.otp_code == "123456"
