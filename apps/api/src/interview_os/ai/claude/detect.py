"""Claude Code detection and health check (port of `claude/detect.ts`)."""

from __future__ import annotations

from collections.abc import Mapping

from ..detect import candidate_names, find_executable, probe_version
from ..interface import RuntimeStatus
from .child_env import build_claude_child_env

__all__ = [
    "CLAUDE_SETUP_MESSAGE",
    "claude_health_check",
    "find_claude_executable",
    "get_claude_version",
]

CLAUDE_SETUP_MESSAGE = (
    "Claude Code not found. Install: npm i -g @anthropic-ai/claude-code, "
    "then run `claude` to log in."
)


async def find_claude_executable(env: Mapping[str, str]) -> str | None:
    return await find_executable(
        env,
        override_key="INTERVIEW_OS_CLAUDE_BIN",
        names=candidate_names("claude", ("claude.cmd", "claude.exe", "claude")),
    )


async def get_claude_version(bin: str, env: Mapping[str, str]) -> str | None:
    return await probe_version(bin, env=build_claude_child_env(env))


async def claude_health_check(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
    executable = await find_claude_executable(env)
    if executable is None:
        return RuntimeStatus(
            runtime="claude",
            available=False,
            workspace=workspace_dir,
            status="unavailable",
            message=CLAUDE_SETUP_MESSAGE,
        )
    version = await get_claude_version(executable, env)
    if version is None:
        return RuntimeStatus(
            runtime="claude",
            available=False,
            executable=executable,
            workspace=workspace_dir,
            status="error",
            message=(
                f"Found Claude Code at {executable} but `--version` failed or timed out. "
                f"{CLAUDE_SETUP_MESSAGE}"
            ),
        )
    return RuntimeStatus(
        runtime="claude",
        available=True,
        version=version,
        executable=executable,
        workspace=workspace_dir,
        status="ready",
        message=f"claude-code {version}",
    )
