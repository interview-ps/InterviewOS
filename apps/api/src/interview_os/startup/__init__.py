"""Process startup helpers — port of `apps/server/src/startup/`.

The package holds the plugin loader (`startup.plugins`), which `main.py` imports
lazily so the backend still boots when this phase is absent.
"""

from __future__ import annotations

__all__: list[str] = []
