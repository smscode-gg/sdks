from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping
from typing import Any, TypeAlias

WebhookEvent: TypeAlias = dict[str, Any]

WEBHOOK_EVENTS = {
    "order.otp_received",
    "order.completed",
    "order.expired",
    "order.canceled",
    "webhook.test",
}
SIGNATURE_PREFIX = "sha256="
SHA256_BYTES = 32


def verify_webhook_signature(raw_body: bytes | str, signature_header: str, secret: str) -> bool:
    if not isinstance(signature_header, str) or not signature_header.startswith(SIGNATURE_PREFIX):
        return False
    digest_hex = signature_header[len(SIGNATURE_PREFIX) :]
    try:
        provided = bytes.fromhex(digest_hex)
    except ValueError:
        return False
    if len(provided) != SHA256_BYTES:
        return False

    expected = hmac.new(_to_bytes(secret), _to_bytes(raw_body), hashlib.sha256).digest()
    return hmac.compare_digest(expected, provided)


def parse_webhook_event(raw_body: bytes | str | object) -> WebhookEvent:
    value = raw_body
    if isinstance(raw_body, bytes):
        value = _json_loads(raw_body.decode("utf-8"))
    elif isinstance(raw_body, str):
        value = _json_loads(raw_body)

    if not isinstance(value, Mapping):
        raise TypeError("Webhook payload is not a JSON object.")
    event = value.get("event")
    if not isinstance(event, str) or event not in WEBHOOK_EVENTS:
        raise TypeError(f"Webhook payload has an unknown event type: {event!r}.")
    return dict(value)


def is_webhook_event(value: object) -> bool:
    if not isinstance(value, Mapping):
        return False
    event = value.get("event")
    return isinstance(event, str) and event in WEBHOOK_EVENTS


def _json_loads(raw: str) -> object:
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        raise TypeError("Webhook payload is not valid JSON.") from err


def _to_bytes(value: bytes | str) -> bytes:
    return value if isinstance(value, bytes) else value.encode("utf-8")
