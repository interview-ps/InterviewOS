"""Shared primitives: the camelCase base models, ids, and the typed app error.

Port of `packages/core/src/shared/{errors,ids}.ts` plus the base-model contract
the other core modules build on. The logger (`shared/logger.ts`) is redacting
infrastructure, not a state shape, and lands with the rest of the core logic.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, ConfigDict, StringConstraints
from pydantic.alias_generators import to_camel

__all__ = [
    "SLUG_ID_REGEX",
    "AppError",
    "CamelModel",
    "JsonNumber",
    "JsonScalar",
    "LooseCamelModel",
    "SlugId",
    "StrictCamelModel",
    "new_id",
]


class CamelModel(BaseModel):
    """Base for every core model: camelCase JSON, snake_case Python.

    `populate_by_name` keeps snake_case input working in Python; JSON output is
    camelCase via `model_dump(by_alias=True)`. Zod objects strip unknown keys by
    default, which is Pydantic's `extra="ignore"`.
    """

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class LooseCamelModel(CamelModel):
    """A `.loose()` Zod object: unknown keys pass through unchanged."""

    model_config = ConfigDict(extra="allow")


class StrictCamelModel(CamelModel):
    """A `z.strictObject(...)`: unknown keys are rejected."""

    model_config = ConfigDict(extra="forbid")


def new_id(prefix: str) -> str:
    """Port of `newId`: `<prefix>_<uuid4>`."""

    return f"{prefix}_{uuid.uuid4()}"


class AppError(Exception):
    """Port of `AppError`: an error carrying the API error `code`."""

    code: str

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.name = "AppError"
        self.code = code


# v0.4: slug ids shared by plugins and packs — safe as directory names.
# (Lives here rather than in `models.skills` so `models.platform` can use it
# without importing the manifest; `models.skills` re-exports it.)
SLUG_ID_REGEX = r"^[a-z0-9][a-z0-9-]{0,63}$"
SlugId = Annotated[str, StringConstraints(pattern=SLUG_ID_REGEX)]


def _reject_bool_number(value: Any) -> Any:
    if isinstance(value, bool):
        raise ValueError("expected a number, got a boolean")
    return value


# `z.union([z.string(), z.number()])` — booleans are not numbers in JS, but
# `bool` is an `int` subclass in Python, so reject it before the union runs.
JsonNumber = Annotated[int | float, BeforeValidator(_reject_bool_number)]
JsonScalar = str | JsonNumber
