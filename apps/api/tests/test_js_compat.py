"""JS-semantics helpers the core port depends on (`js_compat.py`).

The golden fixtures pin `number_to_string` (integral floats in gap reasons and
voice pause messages) and `js_round` (55/200 s → 16.5 → 17, ties toward
+Infinity), but contain no `toFixed` tie, so those cases are pinned here.
Every expected value below was produced by running the expression in Node.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from interview_os.core.js_compat import (
    js_round,
    number_to_string,
    parse_iso_datetime,
    to_fixed,
    to_iso_string,
)


@pytest.mark.parametrize(
    ("value", "digits", "expected"),
    [
        (0.5, 2, "0.50"),
        (0.125, 2, "0.13"),
        (-0.125, 2, "-0.13"),
        (1.005, 2, "1.00"),
        (-1.005, 2, "-1.00"),
        (2.675, 2, "2.67"),
        (-2.675, 2, "-2.67"),
        (0.001, 2, "0.00"),
        (-1e-7, 2, "-0.00"),
        (1.0, 2, "1.00"),
        (1e21, 2, "1e+21"),
    ],
)
def test_to_fixed_matches_node(value: float, digits: int, expected: str) -> None:
    assert to_fixed(value, digits) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (3.0, "3"),
        (1, "1"),
        (0.5, "0.5"),
        (100.0, "100"),
        (0.0, "0"),
        (-0.0, "0"),
        (0.30000000000000004, "0.30000000000000004"),
        (1e-6, "0.000001"),
        (1.1e-6, "0.0000011"),
        (1e-7, "1e-7"),
        (1e21, "1e+21"),
        (1e22, "1e+22"),
        (0.85, "0.85"),
    ],
)
def test_number_to_string_matches_node(value: float, expected: str) -> None:
    assert number_to_string(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(16.5, 17.0), (-2.5, -2.0), (2.5, 3.0), (14.666666666666666, 15.0), (-16.5, -16.0)],
)
def test_js_round_matches_math_round(value: float, expected: float) -> None:
    assert js_round(value) == expected


def test_parse_and_format_iso_datetime() -> None:
    assert to_iso_string(parse_iso_datetime("2026-01-01T00:00:00.000Z")) == (
        "2026-01-01T00:00:00.000Z"
    )
    assert to_iso_string(parse_iso_datetime("2026-01-01T05:30:00+05:30")) == (
        "2026-01-01T00:00:00.000Z"
    )
    assert to_iso_string(datetime(2025, 12, 2, 0, 0, tzinfo=UTC)) == "2025-12-02T00:00:00.000Z"
    # naive datetimes are read as UTC, like Date.parse on an ISO string
    assert to_iso_string(parse_iso_datetime("2026-01-01T00:00:00")) == "2026-01-01T00:00:00.000Z"
    moment = datetime(2026, 1, 1, tzinfo=timezone(timedelta(hours=-5)))
    assert to_iso_string(moment) == "2026-01-01T05:00:00.000Z"
