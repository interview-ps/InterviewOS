"""Codex CLI detection and health check (port of `codex/detect.ts`)."""

from __future__ import annotations

import re
from collections.abc import Mapping

from ..detect import candidate_names, find_executable, probe_version
from ..interface import RuntimeStatus

__all__ = [
    "CODEX_SETUP_MESSAGE",
    "codex_health_check",
    "find_codex_executable",
    "get_codex_version",
]

CODEX_SETUP_MESSAGE = (
    "Codex CLI not found. Install: npm i -g @openai/codex, then run `codex login`."
)

CODEX_VERSION_RE = re.compile(r"(?:codex-cli\s+)?([0-9][^\s]*)")


async def find_codex_executable(env: Mapping[str, str]) -> str | None:
    return await find_executable(
        env,
        override_key="INTERVIEW_OS_CODEX_BIN",
        names=candidate_names("codex", ("codex.cmd", "codex.exe", "codex")),
    )


async def get_codex_version(bin: str) -> str | None:
    """The probe inherits the process environment, as in the TS port."""

    result = await probe_version(bin, pattern=CODEX_VERSION_RE)
    return result


async def codex_health_check(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
    executable = await find_codex_executable(env)
    if executable is None:
        return RuntimeStatus(
            runtime="codex",
            available=False,
            workspace=workspace_dir,
            status="unavailable",
            message=CODEX_SETUP_MESSAGE,
        )
    version = await get_codex_version(executable)
    if version is None:
        return RuntimeStatus(
            runtime="codex",
            available=False,
            executable=executable,
            workspace=workspace_dir,
            status="error",
            message=(
                f"Found Codex at {executable} but `--version` failed or timed out. "
                f"{CODEX_SETUP_MESSAGE}"
            ),
        )
    return RuntimeStatus(
        runtime="codex",
        available=True,
        version=version,
        executable=executable,
        workspace=workspace_dir,
        status="ready",
        message=f"codex-cli {version}",
    )
