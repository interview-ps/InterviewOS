"""Monotonic millisecond clock for the durations the runtimes report.

The TypeScript port measures with `Date.now()` deltas; every use is a duration,
so a monotonic source is the faithful equivalent.
"""

from __future__ import annotations

import time

__all__ = ["now_ms"]


def now_ms() -> int:
    return int(time.monotonic() * 1000)
