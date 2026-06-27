#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml

HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
REQUIRED_CATEGORIES = {
    "operations",
    "webhook_events",
    "error_variants",
    "negative_fixtures",
    "money",
    "capabilities",
    "fx",
    "pagination",
}


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    openapi_path = repo_root / "docs/openapi/openapi.yaml"
    sdk_root = repo_root / "packages/sdk-py"
    manifest_path = sdk_root / "tests/contract_manifest.json"

    problems: list[str] = []
    manifest = load_json(manifest_path)
    openapi = load_yaml(openapi_path)

    categories = set(manifest.get("schema_categories", []))
    missing_categories = REQUIRED_CATEGORIES - categories
    if missing_categories:
        problems.append(f"missing schema categories: {sorted(missing_categories)}")

    expected_operations = public_operations(openapi)
    manifest_operations = {
        (str(entry.get("method")).lower(), str(entry.get("path")))
        for entry in manifest.get("operations", [])
    }
    missing_operations = expected_operations - manifest_operations
    extra_operations = manifest_operations - expected_operations
    if missing_operations:
        problems.append(f"missing operation coverage: {sorted(missing_operations)}")
    if extra_operations:
        problems.append(f"manifest lists non-OpenAPI operations: {sorted(extra_operations)}")

    expected_events = webhook_events(openapi)
    manifest_events = {str(entry.get("event")) for entry in manifest.get("webhook_events", [])}
    missing_events = expected_events - manifest_events
    extra_events = manifest_events - expected_events
    if missing_events:
        problems.append(f"missing webhook event coverage: {sorted(missing_events)}")
    if extra_events:
        problems.append(f"manifest lists non-OpenAPI webhook events: {sorted(extra_events)}")

    for section in ("operations", "webhook_events", "negatives"):
        for entry in manifest.get(section, []):
            fixture = entry.get("fixture")
            if not isinstance(fixture, str):
                problems.append(f"{section} entry has no fixture: {entry}")
                continue
            if not (sdk_root / "tests" / fixture).is_file():
                problems.append(f"{section} fixture missing: {fixture}")

    if not manifest.get("errors"):
        problems.append("manifest must list error variants")

    if problems:
        for problem in problems:
            print(f"python contract stale: {problem}", file=sys.stderr)
        return 1

    print(
        "python contract fresh: "
        f"{len(expected_operations)} operations, "
        f"{len(expected_events)} webhook events, "
        f"{len(manifest.get('errors', []))} errors"
    )
    return 0


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        raise TypeError(f"{path} did not parse as a YAML mapping")
    return data


def public_operations(openapi: dict[str, Any]) -> set[tuple[str, str]]:
    paths = openapi.get("paths")
    if not isinstance(paths, dict):
        raise TypeError("openapi.yaml is missing paths")
    operations: set[tuple[str, str]] = set()
    for path, path_item in paths.items():
        if not isinstance(path, str) or not path.startswith(("/v1/", "/v2/")):
            continue
        if not isinstance(path_item, dict):
            continue
        for method in path_item:
            if method in HTTP_METHODS:
                operations.add((method, path))
    return operations


def webhook_events(openapi: dict[str, Any]) -> set[str]:
    components = openapi.get("components")
    if not isinstance(components, dict):
        raise TypeError("openapi.yaml is missing components")
    schemas = components.get("schemas")
    if not isinstance(schemas, dict):
        raise TypeError("openapi.yaml is missing schemas")

    events: set[str] = set()
    webhook_event = schemas.get("WebhookEvent")
    if isinstance(webhook_event, dict):
        properties = webhook_event.get("properties")
        if isinstance(properties, dict):
            event_schema = properties.get("event")
            if isinstance(event_schema, dict):
                enum = event_schema.get("enum")
                if isinstance(enum, list):
                    events.update(str(value) for value in enum if isinstance(value, str))

    webhook_test_event = schemas.get("WebhookTestEvent")
    if isinstance(webhook_test_event, dict):
        properties = webhook_test_event.get("properties")
        if isinstance(properties, dict):
            event_schema = properties.get("event")
            if isinstance(event_schema, dict) and isinstance(event_schema.get("const"), str):
                events.add(event_schema["const"])

    if not events:
        raise TypeError("openapi.yaml has no webhook events")
    return events


if __name__ == "__main__":
    raise SystemExit(main())
