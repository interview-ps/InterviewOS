"""Fails if any route in routes.json was not exercised by the suite.

Skips are allowed only for routes that cannot run black-box on the mock
runtime; each needs a justification here.
"""

from __future__ import annotations

import json

from harness import coverage

SKIPPED: dict[tuple[str, str], str] = {}


def test_route_coverage() -> None:
    declared = coverage.declared_routes()
    seen = coverage.covered()
    missing = sorted(declared - seen - set(SKIPPED))
    assert not missing, "routes never exercised:\n" + json.dumps(
        [{"method": m, "path": p} for m, p in missing], indent=2
    )
    unknown = sorted(set(SKIPPED) - declared)
    assert not unknown, f"SKIPPED contains routes not in routes.json: {unknown}"
