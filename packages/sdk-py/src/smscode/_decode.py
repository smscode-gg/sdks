from __future__ import annotations

from collections.abc import Mapping
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from smscode.errors import SmscodeError, map_error
from smscode.types import ApiResult


def retry_after_seconds(headers: httpx.Headers) -> float | None:
    value = headers.get("Retry-After")
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        date_header = headers.get("Date")
        if date_header is None:
            return None
        try:
            response_date = parsedate_to_datetime(date_header)
        except (TypeError, ValueError):
            return None
        if response_date.tzinfo is None:
            response_date = response_date.replace(tzinfo=timezone.utc)
        return max(0.0, (retry_at - response_date).total_seconds())
    return max(0.0, seconds)


def retry_after_from_error(err: Exception) -> float | None:
    if isinstance(err, SmscodeError):
        return err.retry_after_seconds
    return None


def decode_response(response: httpx.Response) -> ApiResult[Any]:
    request_id = response.headers.get("X-Request-Id")
    payload = _json_or_none(response)
    envelope = payload if isinstance(payload, Mapping) else None
    is_failure = not response.is_success or (
        envelope is not None and envelope.get("success") is False
    )
    if is_failure:
        raise map_error(
            status=response.status_code,
            payload=envelope,
            request_id=request_id,
            retry_after_seconds=retry_after_seconds(response.headers),
        )

    meta_value = envelope.get("meta") if envelope is not None else None
    meta = dict(meta_value) if isinstance(meta_value, Mapping) else None
    data = envelope.get("data") if envelope is not None and "data" in envelope else payload
    return ApiResult(data=data, meta=meta, request_id=request_id, status=response.status_code)


def _json_or_none(response: httpx.Response) -> object | None:
    if not response.content:
        return None
    try:
        parsed: object = response.json()
        return parsed
    except ValueError:
        return None
