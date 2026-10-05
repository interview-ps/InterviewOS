"""Repository and data paths — port of `apps/server/src/paths.ts`.

Same env overrides as the TypeScript backend, so both can be pointed at the
same database, plugins and packs while the port is in flight.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = [
    "DEFAULT_CONFIG_PATH",
    "DEFAULT_DB_PATH",
    "DEFAULT_EXAMPLES_DIR",
    "DEFAULT_HOST",
    "DEFAULT_INSTALLED_PACKS_DIR",
    "DEFAULT_INSTALLED_PLUGINS_DIR",
    "DEFAULT_MCP_CONFIG_PATH",
    "DEFAULT_PACKS_DIR",
    "DEFAULT_PLUGINS_DIR",
    "DEFAULT_PORT",
    "DEFAULT_RUNTIMES_CONFIG_PATH",
    "DEFAULT_UI_RUNTIME_DIR",
    "DEFAULT_WEB_DIST",
    "REPO_ROOT",
]

# apps/api/src/interview_os/paths.py -> interview_os -> src -> api -> apps -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]

DEFAULT_DB_PATH = Path(os.environ.get("INTERVIEW_OS_DB", REPO_ROOT / "data/interview-os.db"))
DEFAULT_PLUGINS_DIR = Path(os.environ.get("INTERVIEW_OS_PLUGINS_DIR", REPO_ROOT / "plugins"))
DEFAULT_INSTALLED_PLUGINS_DIR = Path(
    os.environ.get("INTERVIEW_OS_INSTALLED_PLUGINS_DIR", REPO_ROOT / "data/plugins")
)
#: Plugin enablement + per-tool config (Octop `~/.octop/config.json` equivalent).
DEFAULT_CONFIG_PATH = Path(
    os.environ.get("INTERVIEW_OS_CONFIG", REPO_ROOT / "data/config.json")
)
DEFAULT_EXAMPLES_DIR = Path(REPO_ROOT / "examples")
DEFAULT_WEB_DIST = Path(REPO_ROOT / "apps/web/dist")

# v0.4 Level 2: built iframe runtime bundle served at /api/ui/runtime/.
DEFAULT_UI_RUNTIME_DIR = Path(REPO_ROOT / "packages/ui/dist/runtime")

# v0.4 packs: bundled content ships with the repo; installed packs are user-added.
DEFAULT_PACKS_DIR = Path(os.environ.get("INTERVIEW_OS_PACKS_DIR", REPO_ROOT / "packs"))
DEFAULT_INSTALLED_PACKS_DIR = Path(
    os.environ.get("INTERVIEW_OS_INSTALLED_PACKS_DIR", REPO_ROOT / "data/packs")
)

# v0.4 MCP: server commands are configured ONLY via this local file.
DEFAULT_MCP_CONFIG_PATH = Path(
    os.environ.get("INTERVIEW_OS_MCP_CONFIG", REPO_ROOT / "interview-os.mcp.json")
)

# v1: trusted local runtime providers — local config only, never HTTP.
DEFAULT_RUNTIMES_CONFIG_PATH = Path(
    os.environ.get("INTERVIEW_OS_RUNTIMES_CONFIG", REPO_ROOT / "interview-os.runtimes.json")
)

DEFAULT_PORT = int(os.environ.get("INTERVIEW_OS_PORT", "4100"))
DEFAULT_HOST = os.environ.get("INTERVIEW_OS_HOST", "127.0.0.1")
