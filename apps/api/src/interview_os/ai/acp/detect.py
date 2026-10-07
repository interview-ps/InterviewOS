"""ACP agent detection and health check.

`find_acp_executable` mirrors the per-provider probes (`INTERVIEW_OS_<KIND>_BIN`
override, then a `PATH` scan). `acp_health_check` spawns the agent and runs the
ACP `initialize` handshake — the ACP analogue of `--version` — then terminates
it. A missing binary is `unavailable`; a handshake failure is `error`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from ..detect import find_executable
from ..interface import RuntimeStatus
from .client import AcpClient, AcpClientOptions
from .config import AcpAgentConfig, build_acp_child_env

__all__ = [
    "HEALTH_TIMEOUT_MS",
    "acp_health_check",
    "find_acp_executable",
]

HEALTH_TIMEOUT_MS = 20_000


async def find_acp_executable(config: AcpAgentConfig, env: Mapping[str, str]) -> str | None:
    if config.command is not None:
        return config.command
    return await find_executable(
        env, override_key=config.override_key, names=config.candidate_names
    )


async def acp_health_check(
    config: AcpAgentConfig,
    env: Mapping[str, str],
    workspace_dir: str,
    *,
    extra_child_env: Mapping[str, Sequence[str]] | None = None,
    timeout_ms: int | None = None,
) -> RuntimeStatus:
    executable = await find_acp_executable(config, env)
    if executable is None:
        return RuntimeStatus(
            runtime=config.kind,
            available=False,
            workspace=workspace_dir,
            status="unavailable",
            message=config.setup_message,
        )

    effective_timeout = timeout_ms if timeout_ms is not None else HEALTH_TIMEOUT_MS
    client = AcpClient(
        AcpClientOptions(
            command=executable,
            args=config.args,
            cwd=workspace_dir,
            env=build_acp_child_env(config, env, extra_child_env),
            request_timeout_ms=effective_timeout,
        )
    )
    try:
        result = await client.initialize(effective_timeout)
    except Exception as err:  # a probe must degrade, never raise
        return RuntimeStatus(
            runtime=config.kind,
            available=False,
            executable=executable,
            workspace=workspace_dir,
            status="error",
            message=f"Found an ACP agent at {executable} but `initialize` failed: {err}. "
            f"{config.setup_message}",
        )
    finally:
        await client.close()

    agent_info = result.get("agentInfo")
    version = agent_info.get("version") if isinstance(agent_info, Mapping) else None
    shown = version if isinstance(version, str) else None
    label = config.display_name or config.kind
    return RuntimeStatus(
        runtime=config.kind,
        available=True,
        version=shown,
        executable=executable,
        workspace=workspace_dir,
        status="ready",
        message=f"{label} {shown}" if shown else label,
    )
