"""JavaScript-compatible primitives the core port needs to stay bit-faithful.

`packages/core` formats numbers and dates with JS semantics:

- `Number.prototype.toFixed(2)` — V8 rounds ties away from zero and keeps the
  sign of values that round to zero; Python's `format(value, ".2f")` rounds
  half to even instead.
- `Number.prototype.toString()` — integral floats print without a trailing
  `.0`; the fixed/exponential switchover is at `1e-6` / `1e21` (Python's `repr`
  switches at `1e-4` / `1e16`).
- `Math.round` — ties round toward +Infinity, unlike Python's `round`.
- `Date.parse` / `Date.prototype.toISOString` — UTC, milliseconds, `Z` suffix.

Only these behaviours are emulated; nothing else about JS numbers leaks into
the port.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

__all__ = [
    "js_round",
    "number_to_string",
    "parse_iso_datetime",
    "to_fixed",
    "to_iso_string",
]

_FIXED_NOTATION_MAX = 1e21


def js_round(value: float) -> float:
    """`Math.round`: ties round toward +Infinity."""

    return math.floor(value + 0.5)


def to_fixed(value: float, digits: int = 2) -> str:
    """`Number.prototype.toFixed(digits)`."""

    if not math.isfinite(value) or abs(value) >= _FIXED_NOTATION_MAX:
        return number_to_string(value)
    # Decimal(float) is the exact binary value, which is what toFixed rounds.
    exact = Decimal(value)
    quantum = Decimal(1).scaleb(-digits)
    return format(exact.quantize(quantum, rounding=ROUND_HALF_UP), "f")


def _expand_exponential(text: str) -> str:
    """`repr`'s shortest digits, written in fixed notation (JS below 1e-6)."""

    mantissa, exponent = text.split("e")
    sign = "-" if mantissa.startswith("-") else ""
    mantissa = mantissa.lstrip("+-")
    digits = mantissa.replace(".", "")
    point = mantissa.index(".") if "." in mantissa else len(mantissa)
    new_point = point + int(exponent)
    if new_point <= 0:
        return f"{sign}0.{'0' * -new_point}{digits}"
    if new_point >= len(digits):
        return f"{sign}{digits}{'0' * (new_point - len(digits))}"
    return f"{sign}{digits[:new_point]}.{digits[new_point:]}"


def number_to_string(value: float | int) -> str:
    """`String(value)` / template-literal interpolation of a number."""

    if isinstance(value, int):
        return str(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < _FIXED_NOTATION_MAX:
        return str(int(value))
    text = repr(value)
    if "e" not in text:
        return text
    if 1e-6 <= abs(value) < _FIXED_NOTATION_MAX:
        return _expand_exponential(text)
    mantissa, exponent = text.split("e")
    return f"{mantissa}e{int(exponent):+d}"


def parse_iso_datetime(value: str) -> datetime:
    """`Date.parse` for ISO-8601 strings; naive input is read as UTC."""

    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def to_iso_string(value: datetime) -> str:
    """`Date.prototype.toISOString`: UTC with milliseconds and a `Z` suffix."""

    utc = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"
