"""JSON text that matches `JSON.stringify`, used to compose prompts.

The runtimes hand prompt text to provider CLIs, so the JSON embedded in those
prompts must read the same as in the TypeScript port: compact by default
(`separators=(",", ":")`), `": "` when indenting, and no ASCII escaping.
"""

from __future__ import annotations

import json

__all__ = ["js_dumps"]


def js_dumps(value: object, *, indent: int | None = None) -> str:
    """`JSON.stringify(value)` or `JSON.stringify(value, null, indent)`."""

    if indent is None:
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return json.dumps(value, indent=indent, separators=(",", ": "), ensure_ascii=False)
