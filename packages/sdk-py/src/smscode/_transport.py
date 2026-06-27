from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

from smscode._decode import decode_response, retry_after_from_error
from smscode.errors import NetworkError, SmscodeError, TimeoutError
from smscode.retry import RetryPolicy, with_retry
from smscode.types import ApiResult, HttpMethod, QueryValue

DEFAULT_BASE_URL = "https://api.smscode.gg"
RETRYABLE_STATUSES = {429, 503}


def build_url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    rel = path if path.startswith("/") else f"/{path}"
    return f"{base}{rel}"


def clean_params(params: Mapping[str, QueryValue] | None) -> dict[str, str] | None:
    if params is None:
        return None
    cleaned: dict[str, str] = {}
    for key, value in params.items():
        if value is None:
            continue
        cleaned[key] = str(value).lower() if isinstance(value, bool) else str(value)
    return cleaned


class SyncTransport:
    def __init__(
        self,
        *,
        token: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout_ms: int = 0,
        max_retries: int = 0,
        client: httpx.Client | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not token:
            raise TypeError("SmscodeClient requires a token.")
        if client is not None and transport is not None:
            raise TypeError("Pass either client or transport, not both.")
        self._token = token
        self._base_url = base_url
        self._max_retries = max(0, max_retries)
        self._owns_client = client is None
        timeout = None if timeout_ms <= 0 else timeout_ms / 1000
        self._client = client or httpx.Client(timeout=timeout, transport=transport)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def request(
        self,
        method: HttpMethod,
        path: str,
        *,
        params: Mapping[str, QueryValue] | None = None,
        json: Any | None = None,
        headers: Mapping[str, str] | None = None,
        retry: int | None = None,
    ) -> ApiResult[Any]:
        max_retries = self._max_retries if retry is None else max(0, retry)
        policy = RetryPolicy(
            max_retries=max_retries,
            retry_on=is_retryable,
            retry_after=retry_after_from_error,
        )
        return with_retry(
            lambda: self._attempt(method, path, params=params, json=json, headers=headers),
            policy,
        )

    def _attempt(
        self,
        method: HttpMethod,
        path: str,
        *,
        params: Mapping[str, QueryValue] | None,
        json: Any | None,
        headers: Mapping[str, str] | None,
    ) -> ApiResult[Any]:
        request_headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if headers is not None:
            request_headers.update(headers)
        try:
            response = self._client.request(
                method,
                build_url(self._base_url, path),
                params=clean_params(params),
                json=json,
                headers=request_headers,
            )
        except httpx.TimeoutException as exc:
            raise TimeoutError(str(exc) or "SMSCode request timed out") from exc
        except httpx.RequestError as exc:
            raise NetworkError(str(exc) or "SMSCode network request failed") from exc
        return decode_response(response)


def is_retryable(err: Exception) -> bool:
    if isinstance(err, NetworkError):
        return True
    return isinstance(err, SmscodeError) and err.http_status in RETRYABLE_STATUSES
