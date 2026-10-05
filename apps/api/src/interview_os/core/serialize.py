"""JSON serialization that matches Zod's omit-undefined semantics.

Zod distinguishes `.optional()` (the key is omitted when the value is
`undefined`) from `.nullable()` (the key is present and `null`). The Pydantic
port maps both to `X | None`, but keeps the distinction: a Zod `.optional()`
field becomes a field **with a default** (`= None`), while a `.nullable()`
field is **required** (`X | None`, no default).

So the rule is: in JSON output, drop a key whose value is `None` **iff its
field is not required**. Required nullable fields (e.g. `voiceFeedback`,
`completedAt`) keep an explicit `null`.
"""

from __future__ import annotations

import enum
from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel

__all__ = ["dump_json"]


def dump_json(value: Any) -> Any:
    """Recursively convert a model/value to JSON-ready data, omitting unset optionals."""

    if isinstance(value, BaseModel):
        fields = type(value).model_fields
        out: dict[str, Any] = {}
        for name, field in fields.items():
            if field.exclude:
                continue
            item = getattr(value, name)
            extra = field.json_schema_extra
            emit_null = isinstance(extra, dict) and extra.get("emit_null") is True
            if item is None and not field.is_required() and not emit_null:
                continue
            key = field.alias or name
            out[key] = dump_json(item)
        return out
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, Mapping):
        return {str(key): dump_json(item) for key, item in value.items()}
    if isinstance(value, str | bytes):
        return value.decode() if isinstance(value, bytes) else value
    if isinstance(value, Sequence):
        return [dump_json(item) for item in value]
    return value
