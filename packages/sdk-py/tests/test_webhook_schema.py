"""Offline JSON-Schema validation of the webhook payload contract.

Parity with the JS SDK, which compiles ajv validators from
``docs/openapi/openapi.yaml`` and validates webhook payloads against the
``WebhookEvent`` schema (which ``$ref``s ``WebhookEventData``). Without this the
Python side only checks the ``event`` discriminant, so a payload could silently
drop a required field (or carry an extra one) and still pass. ``WebhookEventData``
requires all 18 keys and carries the ``x-smscode-tested-closed`` marker. The
published contract is open (a consumer must ignore unknown keys); the strict view
used for our fixtures and examples reads the marker as ``additionalProperties:
false``, so they still match the producer (``webhook_notifier::webhook_data_payload``)
field for field.

Fully offline: loads the OpenAPI doc, resolves the internal
``#/components/schemas/...`` refs, and validates both the shipped fixtures and the
published ``webhooks.orderEvent`` examples.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
import yaml  # type: ignore[import-untyped]
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

HERE = Path(__file__).parent
OPENAPI_PATH = HERE.parents[2] / "docs/openapi/openapi.yaml"
FIXTURES = HERE / "fixtures"
_OPENAPI_BASE = "urn:smscode-openapi"

TESTED_CLOSED = "x-smscode-tested-closed"


def strict_view(doc: dict[str, Any]) -> dict[str, Any]:
    """A deep copy of ``doc`` in which every marker-carrying object node is closed.

    Published server-sent schemas are open: consumers must ignore unknown keys.
    Our own fixtures and examples are validated against this strict view, which
    reads ``x-smscode-tested-closed: true`` as ``additionalProperties: false``.
    """

    def close(node: Any) -> Any:
        if isinstance(node, list):
            return [close(item) for item in node]
        if not isinstance(node, dict):
            return node
        out = {key: close(value) for key, value in node.items()}
        if out.get(TESTED_CLOSED) is True:
            out["additionalProperties"] = False
        return out

    result: dict[str, Any] = close(doc)
    return result


# Parse the (large) OpenAPI doc once and register its strict view so internal
# `#/components/schemas/...` `$ref`s resolve against it.
_DOC: dict[str, Any] = yaml.safe_load(OPENAPI_PATH.read_text())
_REGISTRY = Registry().with_resource(
    _OPENAPI_BASE, Resource.from_contents(strict_view(_DOC), default_specification=DRAFT202012)
)
# The published, open contract: only the policy tests below read it.
_PUBLISHED_REGISTRY = Registry().with_resource(
    _OPENAPI_BASE, Resource.from_contents(_DOC, default_specification=DRAFT202012)
)


def _validator_for(schema_name: str) -> Draft202012Validator:
    return Draft202012Validator(
        {"$ref": f"{_OPENAPI_BASE}#/components/schemas/{schema_name}"}, registry=_REGISTRY
    )


def _errors(validator: Draft202012Validator, payload: Any) -> str:
    return "\n".join(
        f"{list(e.path)}: {e.message}" for e in sorted(validator.iter_errors(payload), key=str)
    )


_WEBHOOK_EVENT = _validator_for("WebhookEvent")

# The 4 order-event fixtures validate against WebhookEvent. webhook_test_event.json
# is a different schema (WebhookTestEvent) and is covered by the discriminant test.
ORDER_FIXTURES = sorted(FIXTURES.glob("webhook_order_*.json"))
ORDER_EXAMPLES: dict[str, Any] = {
    name: ex["value"]
    for name, ex in (
        _DOC.get("webhooks", {})
        .get("orderEvent", {})
        .get("post", {})
        .get("requestBody", {})
        .get("content", {})
        .get("application/json", {})
        .get("examples", {})
    ).items()
    if isinstance(ex, dict) and "value" in ex
}


def test_order_fixtures_present() -> None:
    # Guard the guard: fail loudly rather than validate an empty set (vacuous pass).
    assert len(ORDER_FIXTURES) >= 4


def test_published_order_event_examples_present() -> None:
    # The published examples are the copy-paste payloads a consumer is built against.
    assert ORDER_EXAMPLES, "no webhooks.orderEvent examples in the OpenAPI doc"


@pytest.mark.parametrize("fixture", ORDER_FIXTURES, ids=lambda p: p.name)
def test_order_webhook_fixture_matches_schema(fixture: Path) -> None:
    payload = json.loads(fixture.read_text())
    assert _WEBHOOK_EVENT.is_valid(payload), _errors(_WEBHOOK_EVENT, payload)


@pytest.mark.parametrize("name", sorted(ORDER_EXAMPLES), ids=lambda n: n)
def test_published_order_event_example_matches_schema(name: str) -> None:
    payload = ORDER_EXAMPLES[name]
    assert _WEBHOOK_EVENT.is_valid(payload), _errors(_WEBHOOK_EVENT, payload)


def test_schema_rejects_missing_required_field() -> None:
    # Prove the guard has teeth: dropping a required `data` field must fail — the
    # exact drift the discriminant-only parse test cannot catch.
    broken = copy.deepcopy(next(iter(ORDER_EXAMPLES.values())))
    del broken["data"]["operator_id"]
    assert not _WEBHOOK_EVENT.is_valid(broken)


def test_strict_view_rejects_unknown_data_field() -> None:
    # Our own payloads stay pinned: the strict view closes WebhookEventData, so an
    # extra key (e.g. a stale `status`) must fail.
    broken = copy.deepcopy(next(iter(ORDER_EXAMPLES.values())))
    broken["data"]["status"] = "COMPLETED"
    assert not _WEBHOOK_EVENT.is_valid(broken)


def test_schema_accepts_unknown_data_field() -> None:
    # The published contract is additive: consumers must accept unknown keys.
    payload = copy.deepcopy(next(iter(ORDER_EXAMPLES.values())))
    payload["future_field"] = 1
    payload["data"]["future_field"] = "x"
    published = Draft202012Validator(
        {"$ref": f"{_OPENAPI_BASE}#/components/schemas/WebhookEvent"}, registry=_PUBLISHED_REGISTRY
    )
    assert published.is_valid(payload), _errors(published, payload)


def _synthetic_validators(
    doc: dict[str, Any],
) -> tuple[Draft202012Validator, Draft202012Validator]:
    registry = Registry().with_resource(
        "urn:strict-view", Resource.from_contents(doc, default_specification=DRAFT202012)
    )

    def validator(name: str) -> Draft202012Validator:
        ref = f"urn:strict-view#/components/schemas/{name}"
        return Draft202012Validator({"$ref": ref}, registry=registry)

    return validator("Marked"), validator("Unmarked")


def test_strict_view_closes_marked_schemas() -> None:
    doc: dict[str, Any] = {
        "components": {
            "schemas": {
                "Marked": {
                    "type": "object",
                    "properties": {"a": {"type": "string"}},
                    "x-smscode-tested-closed": True,
                },
                "Unmarked": {"type": "object", "properties": {"a": {"type": "string"}}},
            }
        }
    }
    extra = {"a": "x", "b": 1}
    marked, unmarked = _synthetic_validators(strict_view(doc))
    assert not marked.is_valid(extra)
    assert unmarked.is_valid(extra)
    published_marked, published_unmarked = _synthetic_validators(doc)
    assert published_marked.is_valid(extra)
    assert published_unmarked.is_valid(extra)
