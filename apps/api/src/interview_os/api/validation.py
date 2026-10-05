"""Request-body validation errors in Zod's wording — port of `http/middleware/validate.ts`.

Hono validates every JSON body with `parseBody(c, Schema)` and answers

    {"error": {"code": "VALIDATION",
               "message": "invalid request body: <path>: <Zod message>[; ...]"}}

Zod v4's issue wording (`i.path.join(".") || "body"`, then `i.message`) — see
`validate.ts` and the schemas in `apps/server/src/http/schemas.ts`. The contract
fixtures record those strings byte-for-byte, so the FastAPI port translates
Pydantic's vocabulary into Zod's rather than forwarding Pydantic's own text.

Pydantic error type → Zod message
---------------------------------
    missing (str field)        Invalid input: expected string, received undefined
    missing (bool field)       Invalid input: expected boolean, received undefined
    missing (number field)     Invalid input: expected number, received undefined
    missing (array field)      Invalid input: expected array, received undefined
    missing (object field)     Invalid input: expected object, received undefined
    missing (enum field)       Invalid option: expected one of "a"|"b"
    missing (literal field)    Invalid input: expected "replace"
    bool_type / bool_parsing   Invalid input: expected boolean, received <typeof>
    string_type                Invalid input: expected string, received <typeof>
    int_*/float_*/decimal_*    Invalid input: expected number, received <typeof>
    list_type/tuple_/set_      Invalid input: expected array, received <typeof>
    dict_type/model_type       Invalid input: expected object, received <typeof>
    enum                       Invalid option: expected one of "a"|"b"
    literal_error (several)    Invalid option: expected one of "company"|"role"
    literal_error (one)        Invalid input: expected "replace"
    too_short                  Too small: expected array to have >=2 items
    string_too_short           Too small: expected string to have >=1 characters
    too_long                   Too big: expected array to have <=7 items
    string_too_long            Too big: expected string to have <=300 characters
    greater_than(_equal)       Too small: expected number to be >0 / >=1
    less_than(_equal)          Too big: expected number to be <20 / <=20
    extra_forbidden            Unrecognized key(s) in object: 'x'
    value_error                the validator's own text (`z.refine` message)
    json_invalid               request body must be JSON

The expected type of a *missing* field is not part of a Pydantic error, so the
model that raised it is located separately: the route's body parameter via
`request_body_model()` (FastAPI's `RequestValidationError`), or the model name
Pydantic stores in `ValidationError.title` (a bare `model_validate` failure).
Everything that cannot be translated falls back to Pydantic's own message —
the formatter never raises.
"""

from __future__ import annotations

import re
import types
from collections.abc import Mapping, Sequence
from decimal import Decimal
from enum import Enum
from typing import Any, Literal, Union, get_args, get_origin

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ValidationError
from pydantic.fields import FieldInfo

__all__ = ["format_zod_validation_error", "request_body_model"]

#: Prepended to every translated message (the Hono `validate` middleware).
_PREFIX = "invalid request body: "

#: Hono's `parseBody` answer when `c.req.json()` fails (no issue detail).
_BODY_NOT_JSON = "request body must be JSON"

#: Zod wraps each rejected alternative in double quotes, joined by `|`.
_OPTION_QUOTE = '"'

#: Pydantic's `ctx["expected"]` lists alternatives single-quoted: `"'a' or 'b'"`.
_OPTION_RE = re.compile(r"'([^']*)'")

#: Pydantic error types whose Zod counterpart is a plain type mismatch.
_ZOD_TYPE_ERRORS: dict[str, str] = {
    "bool_type": "boolean",
    "bool_parsing": "boolean",
    "string_type": "string",
    "int_type": "number",
    "int_parsing": "number",
    "float_type": "number",
    "float_parsing": "number",
    "decimal_type": "number",
    "decimal_parsing": "number",
    "list_type": "array",
    "tuple_type": "array",
    "set_type": "array",
    "dict_type": "object",
    "model_type": "object",
    "is_instance_of": "object",
    "callable_type": "object",
}

#: Numeric bound errors → (Zod side, comparison operator, Pydantic ctx key).
_ZOD_NUMBER_BOUNDS: dict[str, tuple[str, str, str]] = {
    "greater_than": ("Too small", ">", "gt"),
    "greater_than_equal": ("Too small", ">=", "ge"),
    "less_than": ("Too big", "<", "lt"),
    "less_than_equal": ("Too big", "<=", "le"),
}

#: `z.refine` / `z.custom` failures: Pydantic prefixes the validator's text.
_VALUE_ERROR_PREFIXES = ("Value error, ", "Assertion failed, ", "Unknown error, ")

_SCALAR_ZOD_TYPES: dict[Any, str] = {
    bool: "boolean",
    str: "string",
    int: "number",
    float: "number",
    Decimal: "number",
}

_EXCLUDED_SEQUENCES = (str, bytes, bytearray)


class _Missing:
    """Sentinel: the Pydantic error carried no `input` value."""


_MISSING = _Missing()


# --------------------------------------------------------------------------
# Entry point


def format_zod_validation_error(
    exc: RequestValidationError | ValidationError,
    *,
    model: type[BaseModel] | None = None,
) -> str:
    """Translate a failed body validation into the Hono error message.

    `exc` is either FastAPI's `RequestValidationError` (a declared body
    parameter) or the plain Pydantic `ValidationError` that `Model.model_validate`
    raises in the routers. `model` is the body model, when the caller knows it
    (see `request_body_model`); otherwise it is looked up by title. The return
    value is the full `message` field, e.g.
    `invalid request body: enabled: Invalid input: expected boolean, received undefined`.
    """

    errors = list(exc.errors())
    if not errors:
        return _PREFIX.rstrip(": ")
    if _body_is_not_json(exc, errors):
        return _BODY_NOT_JSON
    root = model if model is not None else _model_by_title(exc)
    parts = [_format_issue(error, root) for error in errors]
    return _PREFIX + "; ".join(parts)


def request_body_model(request: Request) -> type[BaseModel] | None:
    """The Pydantic model FastAPI validated this request's body against.

    FastAPI nests body failures under a synthetic `body` field, so the reported
    `loc` starts with `("body", ...)` and no longer names the model. The route's
    dependant still holds it: one body parameter (or, for several, a model
    synthesised by FastAPI whose single field is named `body`).
    """

    dependant = getattr(request.scope.get("route"), "dependant", None)
    for field in getattr(dependant, "body_params", None) or ():
        annotation = getattr(getattr(field, "field_info", None), "annotation", None)
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            return annotation
    return None


# --------------------------------------------------------------------------
# One Pydantic issue → one Zod issue


def _format_issue(error: Any, root: type[BaseModel] | None) -> str:
    loc = tuple(error.get("loc") or ())
    return f"{_zod_path(loc)}: {_zod_message(error, root, loc)}"


def _zod_message(error: Any, root: type[BaseModel] | None, loc: Sequence[Any]) -> str:
    kind = str(error.get("type", ""))
    ctx = error.get("ctx") or {}
    value = error.get("input", _MISSING)
    annotation = _annotation_at(root, _trim_body(loc))

    if kind == "missing":
        expected = _missing_message(annotation)
        if expected is not None:
            return expected
    elif kind in ("enum", "literal_error"):
        options = _option_values(error, annotation)
        if options:
            return _invalid_value_message(kind, options)
    elif kind in ("too_short", "string_too_short"):
        bound = ctx.get("min_length")
        if bound is not None:
            container, unit = _container(value, annotation)
            return f"Too small: expected {container} to have >={bound} {unit}"
    elif kind in ("too_long", "string_too_long"):
        bound = ctx.get("max_length")
        if bound is not None:
            container, unit = _container(value, annotation)
            return f"Too big: expected {container} to have <={bound} {unit}"
    elif kind in _ZOD_NUMBER_BOUNDS:
        side, operator, key = _ZOD_NUMBER_BOUNDS[kind]
        bound = ctx.get(key)
        if bound is not None:
            return f"{side}: expected number to be {operator}{bound}"
    elif kind == "extra_forbidden":
        key = str(loc[-1]) if loc else ""
        return f"Unrecognized key(s) in object: '{key}'"
    else:
        zod_type = _ZOD_TYPE_ERRORS.get(kind)
        if zod_type is not None:
            return f"Invalid input: expected {zod_type}, received {_js_type(value)}"

    return _clean(str(error.get("msg", "invalid")))


def _missing_message(annotation: Any | None) -> str | None:
    """Zod's wording for an absent field — needs the field's declared type."""

    if annotation is None:
        return None
    kind = _zod_kind(annotation)
    if kind is None:
        return None
    name, options = kind
    if name in ("enum", "literal"):
        return _invalid_value_message(name, options)
    return f"Invalid input: expected {name}, received undefined"


def _invalid_value_message(kind: str, options: Sequence[str]) -> str:
    """Zod names a set of alternatives differently from a single literal.

    `z.enum(["company", "role"])` → `Invalid option: expected one of "company"|"role"`;
    `z.literal("replace")` → `Invalid input: expected "replace"`. A Pydantic
    `Literal[...]` ports either, so several alternatives mean the first form.
    """

    if kind == "enum" or len(options) > 1:
        return f"Invalid option: expected one of {_quoted(options)}"
    return f"Invalid input: expected {_quoted(options)}"


def _option_values(error: Any, annotation: Any | None) -> tuple[str, ...]:
    """The alternative values Pydantic rejected (enum members or literals)."""

    expected = str((error.get("ctx") or {}).get("expected", ""))
    options = _split_expected(expected)
    if options:
        return options
    kind = _zod_kind(annotation) if annotation is not None else None
    return kind[1] if kind is not None else ()


def _split_expected(expected: str) -> tuple[str, ...]:
    """`"'junior', 'mid' or 'staff'"` → `("junior", "mid", "staff")`."""

    return tuple(_OPTION_RE.findall(expected))


def _container(value: Any, annotation: Any | None) -> tuple[str, str]:
    """`(Zod type, unit)` for a length bound, taken from the value being checked."""

    if isinstance(value, str):
        return "string", "characters"
    if value is not _MISSING and isinstance(value, (list, tuple, set, frozenset)):
        return "array", "items"
    if value is not _MISSING and isinstance(value, Mapping):
        return "object", "properties"
    kind = _zod_kind(annotation) if annotation is not None else None
    if kind is not None and kind[0] == "array":
        return "array", "items"
    if kind is not None and kind[0] == "object":
        return "object", "properties"
    return "string", "characters"


def _quoted(options: Sequence[str]) -> str:
    return "|".join(f"{_OPTION_QUOTE}{option}{_OPTION_QUOTE}" for option in options)


def _clean(msg: str) -> str:
    for prefix in _VALUE_ERROR_PREFIXES:
        if msg.startswith(prefix):
            return msg[len(prefix) :]
    return msg


def _body_is_not_json(exc: RequestValidationError | ValidationError, errors: list[Any]) -> bool:
    """`parseBody` answers "request body must be JSON" before any schema runs."""

    for error in errors:
        kind = error.get("type")
        if kind == "json_invalid":
            return True
        # An absent body is reported as the synthetic `body` field missing.
        if isinstance(exc, RequestValidationError) and kind == "missing":
            if tuple(error.get("loc") or ()) == ("body",):
                return True
    return False


# --------------------------------------------------------------------------
# Paths


def _zod_path(loc: Sequence[Any]) -> str:
    """Pydantic `loc` → the Zod path (`i.path.join(".") || "body"`)."""

    parts = [str(part) for part in _trim_body(loc)]
    return ".".join(parts) or "body"


def _trim_body(loc: Sequence[Any]) -> tuple[Any, ...]:
    """Drop FastAPI's leading `body` segment — Zod's path has no such prefix."""

    if loc and loc[0] == "body":
        return tuple(loc[1:])
    return tuple(loc)


def _js_type(value: Any) -> str:
    """`typeof` for a JSON value, as Zod names it in `<...>, received <...>`."""

    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple, set, frozenset)):
        return "array"
    if isinstance(value, Mapping):
        return "object"
    return "object"


# --------------------------------------------------------------------------
# Locating the model + the field annotation behind a `loc`


def _model_by_title(exc: RequestValidationError | ValidationError) -> type[BaseModel] | None:
    """Resolve Pydantic's `title` (the model's `__name__`) to the model class."""

    title = getattr(exc, "title", None)
    if not isinstance(title, str) or not title:
        return None
    return _registry_lookup(title)


_REGISTRY: dict[str, type[BaseModel]] = {}
_REGISTRY_BUILT = False


def _build_registry() -> None:
    """Index every model class defined so far by name (routes import lazily)."""

    global _REGISTRY_BUILT

    found: dict[str, type[BaseModel]] = {}
    stack: list[type[Any]] = [BaseModel]
    while stack:
        current = stack.pop()
        for sub in current.__subclasses__():
            if sub.__name__ in found:
                continue
            found[sub.__name__] = sub
            stack.append(sub)
    _REGISTRY.clear()
    _REGISTRY.update(found)
    _REGISTRY_BUILT = True


def _registry_lookup(title: str) -> type[BaseModel] | None:
    if not _REGISTRY_BUILT:
        _build_registry()
    model = _REGISTRY.get(title)
    if model is None:
        # A schema defined after the last build (a route module imported later)
        # is not in the index yet — rebuild once before giving up.
        _build_registry()
        model = _REGISTRY.get(title)
    return model


def _annotation_at(root: type[BaseModel] | None, loc: Sequence[Any]) -> Any | None:
    """Walk `loc` through `root` and return the annotation of the failing field."""

    if root is None:
        return None
    current: Any = root
    for part in loc:
        current = _strip_optional(current)
        if isinstance(part, int):
            current = _sequence_item(current)
        elif isinstance(current, type) and issubclass(current, BaseModel):
            field = _field(current, str(part))
            if field is None:
                return None
            current = field.annotation
        else:
            current = _mapping_value(current)
        if current is None:
            return None
    return _strip_optional(current)


def _field(model: type[BaseModel], name: str) -> FieldInfo | None:
    """The field whose JSON key is `name` (alias first, then the Python name)."""

    fields = model.model_fields
    direct = fields.get(name)
    if direct is not None:
        return direct
    for info in fields.values():
        validation_alias = info.validation_alias
        if info.alias == name or (
            validation_alias is not None and str(validation_alias) == name
        ):
            return info
    return None


def _sequence_item(annotation: Any) -> Any | None:
    """`list[X]` / `tuple[X, ...]` / `set[X]` → `X`."""

    args = get_args(annotation)
    return args[0] if args else None


def _mapping_value(annotation: Any) -> Any | None:
    args = get_args(annotation)
    if len(args) == 2:
        return args[1]
    return None


# --------------------------------------------------------------------------
# Python annotation → Zod's type vocabulary


def _zod_kind(annotation: Any) -> tuple[str, tuple[str, ...]] | None:
    """`(Zod kind, alternative values)` for an annotation, or `None` if unknown."""

    annotation = _strip_optional(annotation)
    if annotation is None:
        return None
    union_members = _union_members(annotation)
    if union_members is not None:
        kinds = {_zod_kind(member) for member in union_members}
        if len(kinds) == 1:
            return kinds.pop()
        return None
    if get_origin(annotation) is Literal:
        return "literal", tuple(str(arg) for arg in get_args(annotation))
    if isinstance(annotation, type) and issubclass(annotation, Enum):
        return "enum", tuple(str(member.value) for member in annotation)
    if annotation in _SCALAR_ZOD_TYPES:
        return _SCALAR_ZOD_TYPES[annotation], ()
    if _is_sequence(annotation):
        return "array", ()
    if _is_mapping(annotation):
        return "object", ()
    return None


def _strip_optional(annotation: Any) -> Any:
    """`Annotated[X, ...]` → `X`; `X | None` / `Optional[X]` → `X`."""

    while hasattr(annotation, "__metadata__"):
        annotation = annotation.__origin__
    members = _union_members(annotation)
    if members is not None and len(members) == 1:
        return _strip_optional(members[0])
    return annotation


def _union_members(annotation: Any) -> list[Any] | None:
    """Non-`None` union members, or `None` when `annotation` is not a union."""

    origin = get_origin(annotation)
    if origin is not Union and origin is not types.UnionType:
        return None
    members = [arg for arg in get_args(annotation) if arg is not type(None)]
    return members or None


def _is_sequence(annotation: Any) -> bool:
    if isinstance(annotation, type):
        return issubclass(annotation, Sequence) and not issubclass(annotation, _EXCLUDED_SEQUENCES)
    origin = get_origin(annotation)
    return (
        isinstance(origin, type)
        and issubclass(origin, Sequence)
        and not issubclass(origin, _EXCLUDED_SEQUENCES)
    )


def _is_mapping(annotation: Any) -> bool:
    if isinstance(annotation, type):
        return issubclass(annotation, Mapping)
    origin = get_origin(annotation)
    return isinstance(origin, type) and issubclass(origin, Mapping)
