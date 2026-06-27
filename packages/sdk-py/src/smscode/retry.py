from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

T = TypeVar("T")

BACKOFF_BASE_SECONDS = 0.250
BACKOFF_CAP_SECONDS = 10.0


@dataclass(frozen=True)
class RetryPolicy:
    max_retries: int = 0
    retry_on: Callable[[Exception], bool] = lambda err: False
    retry_after: Callable[[Exception], float | None] | None = None
    delay_seconds: Callable[[int], float] | None = None
    sleep: Callable[[float], None] | None = None
    async_sleep: Callable[[float], Awaitable[None]] | None = None


def default_delay_seconds(attempt: int) -> float:
    ceiling = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** max(0, attempt - 1))
    return float(random.random() * ceiling)


def _retry_delay_seconds(err: Exception, attempt: int, policy: RetryPolicy) -> float:
    retry_after = policy.retry_after(err) if policy.retry_after is not None else None
    if retry_after is not None:
        return max(0.0, retry_after)
    delay = (
        policy.delay_seconds(attempt)
        if policy.delay_seconds is not None
        else default_delay_seconds(attempt)
    )
    return max(0.0, delay)


def with_retry(fn: Callable[[], T], policy: RetryPolicy) -> T:
    sleep = policy.sleep or time.sleep
    max_retries = max(0, policy.max_retries)
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as err:
            if attempt >= max_retries or not policy.retry_on(err):
                raise
            sleep(_retry_delay_seconds(err, attempt + 1, policy))
    raise RuntimeError("unreachable retry loop")


async def async_with_retry(fn: Callable[[], Awaitable[T]], policy: RetryPolicy) -> T:
    sleep = policy.async_sleep or asyncio.sleep
    max_retries = max(0, policy.max_retries)
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except Exception as err:
            if attempt >= max_retries or not policy.retry_on(err):
                raise
            await sleep(_retry_delay_seconds(err, attempt + 1, policy))
    raise RuntimeError("unreachable retry loop")
