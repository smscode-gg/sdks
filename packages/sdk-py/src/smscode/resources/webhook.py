from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal

from smscode.errors import InvalidResponseError
from smscode.models import WebhookConfig, WebhookTestResult
from smscode.types import ApiResult

SyncRequest = Callable[..., ApiResult[Any]]
AsyncRequest = Callable[..., Awaitable[ApiResult[Any]]]
ApiPrefix = Literal["/v1", "/v2"]


def _update_body(
    *,
    webhook_url: str | None = None,
    webhook_secret: str | None = None,
) -> dict[str, str]:
    body: dict[str, str] = {}
    if webhook_url is not None:
        body["webhook_url"] = webhook_url
    if webhook_secret is not None:
        body["webhook_secret"] = webhook_secret
    return body


def _decode_webhook_config(data: object) -> WebhookConfig:
    if not isinstance(data, dict):
        raise InvalidResponseError("The webhook config response is malformed.")
    consecutive = data.get("webhook_consecutive_failures")
    return WebhookConfig(
        webhook_url=data.get("webhook_url") if isinstance(data.get("webhook_url"), str) else None,
        webhook_secret=(
            data.get("webhook_secret") if isinstance(data.get("webhook_secret"), str) else None
        ),
        webhook_disabled_at=(
            data.get("webhook_disabled_at")
            if isinstance(data.get("webhook_disabled_at"), str)
            else None
        ),
        webhook_disabled_reason=(
            data.get("webhook_disabled_reason")
            if isinstance(data.get("webhook_disabled_reason"), str)
            else None
        ),
        webhook_consecutive_failures=consecutive if type(consecutive) is int else 0,
        raw=dict(data),
    )


def _decode_webhook_test_result(data: object) -> WebhookTestResult:
    if not isinstance(data, dict) or type(data.get("status_code")) is not int:
        raise InvalidResponseError("The webhook test response is malformed.")
    return WebhookTestResult(status_code=data["status_code"], raw=dict(data))


class WebhookResource:
    def __init__(self, request: SyncRequest, prefix: ApiPrefix) -> None:
        self._request = request
        self._prefix = prefix

    def get(self) -> WebhookConfig:
        return _decode_webhook_config(self._request("GET", f"{self._prefix}/webhook").data)

    def update(
        self,
        *,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
    ) -> WebhookConfig:
        return _decode_webhook_config(
            self._request(
                "PATCH",
                f"{self._prefix}/webhook",
                json=_update_body(webhook_url=webhook_url, webhook_secret=webhook_secret),
                retry=0,
            ).data
        )

    def test(self) -> WebhookTestResult:
        return _decode_webhook_test_result(
            self._request("POST", f"{self._prefix}/webhook/test", retry=0).data
        )


class V2WebhookResource(WebhookResource):
    def __init__(self, request: SyncRequest) -> None:
        super().__init__(request, "/v2")


class V1WebhookResource(WebhookResource):
    def __init__(self, request: SyncRequest) -> None:
        super().__init__(request, "/v1")


class AsyncWebhookResource:
    def __init__(self, request: AsyncRequest, prefix: ApiPrefix) -> None:
        self._request = request
        self._prefix = prefix

    async def get(self) -> WebhookConfig:
        return _decode_webhook_config((await self._request("GET", f"{self._prefix}/webhook")).data)

    async def update(
        self,
        *,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
    ) -> WebhookConfig:
        return _decode_webhook_config(
            (
                await self._request(
                    "PATCH",
                    f"{self._prefix}/webhook",
                    json=_update_body(webhook_url=webhook_url, webhook_secret=webhook_secret),
                    retry=0,
                )
            ).data
        )

    async def test(self) -> WebhookTestResult:
        return _decode_webhook_test_result(
            (await self._request("POST", f"{self._prefix}/webhook/test", retry=0)).data
        )


class AsyncV2WebhookResource(AsyncWebhookResource):
    def __init__(self, request: AsyncRequest) -> None:
        super().__init__(request, "/v2")


class AsyncV1WebhookResource(AsyncWebhookResource):
    def __init__(self, request: AsyncRequest) -> None:
        super().__init__(request, "/v1")
