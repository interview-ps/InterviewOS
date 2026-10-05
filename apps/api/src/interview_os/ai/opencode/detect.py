"""opencode CLI detection and health check (port of `opencode/detect.ts`)."""

from __future__ import annotations

from collections.abc import Mapping

from ..detect import candidate_names, find_executable, probe_version
from ..interface import RuntimeStatus
from .child_env import build_opencode_child_env

__all__ = [
    "OPENCODE_SETUP_MESSAGE",
    "find_opencode_executable",
    "get_opencode_version",
    "opencode_health_check",
]

OPENCODE_SETUP_MESSAGE = (
    "opencode not found. Install: npm i -g opencode-ai, then run `opencode auth login`."
)


async def find_opencode_executable(env: Mapping[str, str]) -> str | None:
    return await find_executable(
        env,
        override_key="INTERVIEW_OS_OPENCODE_BIN",
        names=candidate_names("opencode", ("opencode.cmd", "opencode.exe", "opencode")),
    )


async def get_opencode_version(bin: str, env: Mapping[str, str]) -> str | None:
    return await probe_version(bin, env=build_opencode_child_env(env))


async def opencode_health_check(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
    executable = await find_opencode_executable(env)
    if executable is None:
        return RuntimeStatus(
            runtime="opencode",
            available=False,
            workspace=workspace_dir,
            status="unavailable",
            message=OPENCODE_SETUP_MESSAGE,
        )
    version = await get_opencode_version(executable, env)
    if version is None:
        return RuntimeStatus(
            runtime="opencode",
            available=False,
            executable=executable,
            workspace=workspace_dir,
            status="error",
            message=(
                f"Found opencode at {executable} but `--version` failed or timed out. "
                f"{OPENCODE_SETUP_MESSAGE}"
            ),
        )
    return RuntimeStatus(
        runtime="opencode",
        available=True,
        version=version,
        executable=executable,
        workspace=workspace_dir,
        status="ready",
        message=f"opencode {version}",
    )
