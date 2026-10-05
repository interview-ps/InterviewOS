"""Devin CLI detection and health check (port of `devin/detect.ts`)."""

from __future__ import annotations

from collections.abc import Mapping

from ..detect import candidate_names, find_executable, probe_version
from ..interface import RuntimeStatus
from .child_env import build_devin_child_env

__all__ = [
    "DEVIN_SETUP_MESSAGE",
    "devin_health_check",
    "find_devin_executable",
    "get_devin_version",
]

DEVIN_SETUP_MESSAGE = (
    "Devin CLI not found. Install it from https://devin.ai, then run `devin auth login`."
)


async def find_devin_executable(env: Mapping[str, str]) -> str | None:
    return await find_executable(
        env,
        override_key="INTERVIEW_OS_DEVIN_BIN",
        names=candidate_names("devin", ("devin.exe", "devin.cmd", "devin")),
    )


async def get_devin_version(bin: str, env: Mapping[str, str]) -> str | None:
    return await probe_version(bin, env=build_devin_child_env(env))


async def devin_health_check(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
    executable = await find_devin_executable(env)
    if executable is None:
        return RuntimeStatus(
            runtime="devin",
            available=False,
            workspace=workspace_dir,
            status="unavailable",
            message=DEVIN_SETUP_MESSAGE,
        )
    version = await get_devin_version(executable, env)
    if version is None:
        return RuntimeStatus(
            runtime="devin",
            available=False,
            executable=executable,
            workspace=workspace_dir,
            status="error",
            message=(
                f"Found devin at {executable} but `devin version` failed or timed out. "
                f"{DEVIN_SETUP_MESSAGE}"
            ),
        )
    return RuntimeStatus(
        runtime="devin",
        available=True,
        version=version,
        executable=executable,
        workspace=workspace_dir,
        status="ready",
        message=f"devin {version}",
    )
