from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import pytest

from smscode import (
    InvalidMoneyError,
    InvalidResponseError,
    SmscodeError,
    map_error,
    parse_webhook_event,
)
from smscode.resources.balance import V1BalanceResource, V2BalanceResource
from smscode.resources.catalog import V1CatalogResource, V2CatalogResource
from smscode.resources.orders import V1OrdersResource, V2OrdersResource
from smscode.resources.webhook import V1WebhookResource, V2WebhookResource
from smscode.types import ApiResult

HERE = Path(__file__).parent
MANIFEST_PATH = HERE / "contract_manifest.json"
OPENAPI_PATH = HERE.parents[2] / "docs/openapi/openapi.yaml"


def load_manifest() -> dict[str, Any]:
    parsed = json.loads(MANIFEST_PATH.read_text())
    if not isinstance(parsed, dict):
        raise TypeError("contract_manifest.json must be a JSON object")
    return parsed


def load_fixture(path: str) -> dict[str, Any]:
    parsed = json.loads((HERE / path).read_text())
    if not isinstance(parsed, dict):
        raise TypeError(f"{path} must be a JSON object")
    return parsed


def result_from_fixture(path: str) -> ApiResult[Any]:
    envelope = load_fixture(path)
    return ApiResult(
        data=envelope.get("data"),
        meta=envelope.get("meta") if isinstance(envelope.get("meta"), dict) else None,
        request_id=(
            envelope.get("request_id") if isinstance(envelope.get("request_id"), str) else None
        ),
        status=int(envelope.get("status", 200)),
    )


class FakeRequest:
    def __init__(self, result: ApiResult[Any]) -> None:
        self.result = result
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def __call__(self, method: str, path: str, **kwargs: Any) -> ApiResult[Any]:
        self.calls.append((method, path, kwargs))
        return self.result


def decode_operation(entry: Mapping[str, Any]) -> Any:
    fixture = str(entry["fixture"])
    result = result_from_fixture(fixture)
    request = FakeRequest(result)
    decoder = str(entry["decoder"])
    decoders: dict[str, Callable[[], Any]] = {
        "v1.catalog.countries": lambda: V1CatalogResource(request).countries(),
        "v1.catalog.services": lambda: V1CatalogResource(request).services(country_id=7),
        "v1.catalog.operators": lambda: V1CatalogResource(request).operators(
            country_id=7, platform_id=1
        ),
        "v1.catalog.products": lambda: V1CatalogResource(request).products(country_id=7),
        "v1.catalog.exchange_rate": lambda: V1CatalogResource(request).exchange_rate(),
        "v1.balance.get": lambda: V1BalanceResource(request).get(),
        "v1.orders.list": lambda: V1OrdersResource(request).list(limit=1),
        "v1.orders.active": lambda: V1OrdersResource(request).active(),
        "v1.orders.get": lambda: V1OrdersResource(request).get(1),
        "v1.orders.create": lambda: V1OrdersResource(request).create(
            {},
            idempotency_key="stable-key",
        ),
        "v1.orders.cancel": lambda: V1OrdersResource(request).cancel(1),
        "v1.orders.finish": lambda: V1OrdersResource(request).finish(1),
        "v1.orders.resend": lambda: V1OrdersResource(request).resend(1),
        "v1.orders.reactivate": lambda: V1OrdersResource(request).reactivate(
            1, idempotency_key="stable-key"
        ),
        "v1.orders.reactivate_options": lambda: V1OrdersResource(request).reactivate_options(1),
        "v1.webhook.get": lambda: V1WebhookResource(request).get(),
        "v1.webhook.update": lambda: V1WebhookResource(request).update(webhook_url=""),
        "v1.webhook.test": lambda: V1WebhookResource(request).test(),
        "v2.catalog.countries": lambda: V2CatalogResource(request).countries(),
        "v2.catalog.services": lambda: V2CatalogResource(request).services(country_id=7),
        "v2.catalog.operators": lambda: V2CatalogResource(request).operators(
            country_id=7, platform_id=1
        ),
        "v2.catalog.products": lambda: V2CatalogResource(request).products(country_id=7),
        "v2.catalog.exchange_rate": lambda: V2CatalogResource(request).exchange_rate(),
        "v2.balance.get": lambda: V2BalanceResource(request).get(),
        "v2.orders.list": lambda: V2OrdersResource(request).list(limit=1),
        "v2.orders.active": lambda: V2OrdersResource(request).active(),
        "v2.orders.get": lambda: V2OrdersResource(request).get(1),
        "v2.orders.create": lambda: V2OrdersResource(request).create(
            {},
            idempotency_key="stable-key",
        ),
        "v2.orders.cancel": lambda: V2OrdersResource(request).cancel(1),
        "v2.orders.finish": lambda: V2OrdersResource(request).finish(1),
        "v2.orders.resend": lambda: V2OrdersResource(request).resend(1),
        "v2.orders.reactivate": lambda: V2OrdersResource(request).reactivate(
            1, idempotency_key="stable-key"
        ),
        "v2.orders.reactivate_options": lambda: V2OrdersResource(request).reactivate_options(1),
        "v2.webhook.get": lambda: V2WebhookResource(request).get(),
        "v2.webhook.update": lambda: V2WebhookResource(request).update(webhook_url=""),
        "v2.webhook.test": lambda: V2WebhookResource(request).test(),
    }
    return decoders[decoder]()


def test_manifest_schema_categories_are_complete() -> None:
    manifest = load_manifest()
    assert set(manifest["schema_categories"]) >= {
        "operations",
        "webhook_events",
        "error_variants",
        "negative_fixtures",
        "money",
        "capabilities",
        "fx",
        "pagination",
    }


def test_manifest_covers_all_webhook_events_from_openapi() -> None:
    import yaml  # type: ignore[import-untyped]

    openapi = yaml.safe_load(OPENAPI_PATH.read_text())
    event_schema = openapi["components"]["schemas"]["WebhookEvent"]["properties"]["event"]
    expected_events = set(event_schema["enum"])
    expected_events.add(
        openapi["components"]["schemas"]["WebhookTestEvent"]["properties"]["event"]["const"]
    )
    manifest_events = {entry["event"] for entry in load_manifest()["webhook_events"]}
    assert manifest_events == expected_events


@pytest.mark.parametrize("entry", load_manifest().get("operations", []))
def test_public_operation_fixtures_decode(entry: Mapping[str, Any]) -> None:
    assert decode_operation(entry) is not None


@pytest.mark.parametrize("entry", load_manifest().get("webhook_events", []))
def test_webhook_event_fixtures_parse(entry: Mapping[str, Any]) -> None:
    event = parse_webhook_event(load_fixture(str(entry["fixture"])))
    assert event["event"] == entry["event"]


@pytest.mark.parametrize("entry", load_manifest().get("errors", []))
def test_error_variants_map_to_typed_errors(entry: Mapping[str, Any]) -> None:
    err = map_error(
        status=int(entry["status"]),
        payload={"error": {"code": entry["code"], "message": "contract error"}},
        request_id="req_contract",
        retry_after_seconds=None,
    )
    assert err.code == entry["code"]
    assert err.__class__.__name__ == entry["class"]


@pytest.mark.parametrize("entry", load_manifest().get("negatives", []))
def test_negative_fixtures_raise_expected_errors(entry: Mapping[str, Any]) -> None:
    expected = {
        "InvalidResponseError": InvalidResponseError,
        "InvalidMoneyError": InvalidMoneyError,
        "SmscodeError": SmscodeError,
    }[str(entry["raises"])]
    with pytest.raises(expected):
        decode_operation(entry)
