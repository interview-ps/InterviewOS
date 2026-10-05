"""Minimal plugin entry: deterministic execute(), no capabilities."""

from __future__ import annotations

from typing import Any

__all__ = ["execute", "setup"]


def execute(_input: object, request: object = None) -> dict[str, Any]:
    return {"ok": True, "echo": request, "from": "contract-demo-plugin"}


def setup(_ctx: Any) -> None:
    return None
