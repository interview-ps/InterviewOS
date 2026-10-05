"""Route coverage registry.

`client` records every request's (method, path-template); the zz coverage test
compares the registry against routes.json.
"""

from __future__ import annotations

import json
from pathlib import Path

ROUTES_JSON = Path(__file__).resolve().parents[1] / "routes.json"

_seen: set[tuple[str, str]] = set()


def record(method: str, template: str) -> None:
    _seen.add((method.upper(), template))


def covered() -> set[tuple[str, str]]:
    return set(_seen)


def reset() -> None:
    _seen.clear()


def declared_routes() -> set[tuple[str, str]]:
    routes = json.loads(ROUTES_JSON.read_text(encoding="utf-8"))
    return {(r["method"].upper(), r["path"]) for r in routes}
