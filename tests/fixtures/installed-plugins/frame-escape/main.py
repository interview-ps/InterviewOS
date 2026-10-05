"""frame-escape fixture — a hostile UI-frame plugin.

Pure UI plugin: it registers no hooks/tools; the dashboard card is a frame that
loads `ui/index.js` in the sandboxed iframe and reports the escape probes.
"""

from __future__ import annotations

from typing import Any

__all__ = ["setup"]


def setup(_ctx: Any) -> None:
    return None
