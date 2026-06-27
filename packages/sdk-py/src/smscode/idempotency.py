from __future__ import annotations

import re
import uuid

from smscode.errors import ValidationError

IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def is_valid_idempotency_key(key: str) -> bool:
    return bool(IDEMPOTENCY_KEY_PATTERN.fullmatch(key))


def resolve_idempotency_key(provided: str | None = None) -> str:
    if provided is not None:
        if not is_valid_idempotency_key(provided):
            raise ValidationError(
                f"Invalid idempotency key {provided!r} (allowed: A-Z a-z 0-9 _ - ; 1-128 chars)."
            )
        return provided
    return str(uuid.uuid4())
