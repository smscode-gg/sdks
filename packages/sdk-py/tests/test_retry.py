from smscode import RetryPolicy
from smscode.retry import with_retry


def test_retry_honors_retry_after_before_backoff() -> None:
    waits: list[float] = []
    attempts = 0

    def op() -> str:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("retry")
        return "ok"

    result = with_retry(
        op,
        RetryPolicy(
            max_retries=1,
            retry_on=lambda err: True,
            retry_after=lambda err: 2.0,
            sleep=lambda seconds: waits.append(seconds),
        ),
    )

    assert result == "ok"
    assert waits == [2.0]
