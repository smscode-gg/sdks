import hashlib
import hmac
import json

import pytest
import respx

from smscode import (
    AsyncSmscodeClient,
    ServiceUnavailableError,
    SmscodeClient,
    WebhookConfig,
    WebhookTestResult,
    is_webhook_event,
    parse_webhook_event,
    verify_webhook_signature,
)


def _signature(raw: bytes, secret: str) -> str:
    digest = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def test_verify_webhook_signature_accepts_only_valid_raw_body_signature() -> None:
    raw = b'{"event":"webhook.test","data":{"ok":true}}'
    header = _signature(raw, "secret")

    assert verify_webhook_signature(raw, header, "secret")
    assert verify_webhook_signature(raw.decode(), header, "secret")
    assert not verify_webhook_signature(raw + b" ", header, "secret")
    assert not verify_webhook_signature(raw, header, "wrong")
    assert not verify_webhook_signature(raw, "not-a-signature", "secret")
    assert not verify_webhook_signature(raw, "sha256=nothex", "secret")


def test_parse_webhook_event_uses_event_discriminant() -> None:
    raw = json.dumps({"event": "order.otp_received", "data": {"otp_code": "123456"}})
    event = parse_webhook_event(raw)

    assert event["event"] == "order.otp_received"
    assert is_webhook_event(event)
    assert not is_webhook_event({"type": "order.otp_received"})
    with pytest.raises(TypeError):
        parse_webhook_event({"type": "order.otp_received", "data": {}})


def test_webhook_resources_hit_v2_and_v1_paths() -> None:
    config = {
        "webhook_url": "https://example.com/hooks/smscode",
        "webhook_secret": "secret",
        "webhook_disabled_at": None,
        "webhook_disabled_reason": None,
        "webhook_consecutive_failures": 0,
    }
    with respx.mock(base_url="https://api.smscode.gg") as router:
        v2_get = router.get("/v2/webhook").respond(
            200,
            json={"success": True, "data": config},
        )
        v2_update = router.patch("/v2/webhook").respond(
            200,
            json={"success": True, "data": {**config, "webhook_secret": "new"}},
        )
        v2_test = router.post("/v2/webhook/test").respond(
            200,
            json={"success": True, "data": {"status_code": 204}},
        )
        v1_get = router.get("/v1/webhook").respond(
            200,
            json={"success": True, "data": config},
        )
        with SmscodeClient(token="tok") as client:
            got = client.webhook.get()
            updated = client.webhook.update(webhook_secret="new")
            test_result = client.webhook.test()
            v1_got = client.v1.webhook.get()

    assert isinstance(got, WebhookConfig)
    assert got.webhook_url == config["webhook_url"]
    assert isinstance(updated, WebhookConfig)
    assert updated.webhook_secret == "new"
    assert isinstance(test_result, WebhookTestResult)
    assert test_result.status_code == 204
    assert test_result.status == 204
    assert isinstance(v1_got, WebhookConfig)
    assert v1_got.webhook_secret == "secret"

    assert v2_get.called
    assert v2_update.calls[0].request.content == b'{"webhook_secret":"new"}'
    assert v2_test.called
    assert v1_get.called


def test_webhook_update_and_test_are_not_auto_retried() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        update = router.patch("/v2/webhook").respond(
            503,
            json={"success": False, "error": {"code": "SERVICE_UNAVAILABLE", "message": "down"}},
        )
        test = router.post("/v1/webhook/test").respond(
            503,
            json={"success": False, "error": {"code": "SERVICE_UNAVAILABLE", "message": "down"}},
        )
        with (
            SmscodeClient(token="tok", max_retries=1) as client,
            pytest.raises(ServiceUnavailableError),
        ):
            client.webhook.update(webhook_url="https://example.com/hooks/smscode")
        with (
            SmscodeClient(token="tok", max_retries=1) as client,
            pytest.raises(ServiceUnavailableError),
        ):
            client.v1.webhook.test()

    assert update.call_count == 1
    assert test.call_count == 1


@pytest.mark.asyncio
async def test_async_webhook_resource_mirrors_sync_paths() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.get("/v2/webhook").respond(
            200,
            json={
                "success": True,
                "data": {
                    "webhook_url": None,
                    "webhook_secret": None,
                    "webhook_disabled_at": None,
                    "webhook_disabled_reason": None,
                    "webhook_consecutive_failures": 0,
                },
            },
        )
        async with AsyncSmscodeClient(token="tok") as client:
            config = await client.webhook.get()

    assert route.called
    assert isinstance(config, WebhookConfig)
    assert config.webhook_url is None
