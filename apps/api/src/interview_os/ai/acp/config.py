"""Configuration for an ACP agent (`ai/acp`).

An ACP provider is fully described by an :class:`AcpAgentConfig`: the argv that
launches the agent, how its executable is found, the child-environment
allowlist, the setup hint, and the static model fallback. The built-ins live in
`ai.providers`; trusted local providers may declare one from
`interview-os.runtimes.json`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ..interface import ModelInfo

__all__ = ["AcpAgentConfig", "build_acp_child_env", "merge_child_env_extra"]


@dataclass(frozen=True, slots=True)
class AcpAgentConfig:
    #: Runtime kind — must equal the registered provider kind (`opencode`, …).
    kind: str
    #: Agent subcommand argv (e.g. `("acp",)`), appended to the resolved binary.
    args: tuple[str, ...]
    #: Env var that overrides the binary (`INTERVIEW_OS_OPENCODE_BIN`).
    override_key: str
    #: Executable names to scan on `PATH`, in order.
    candidate_names: tuple[str, ...]
    #: Shown when the agent cannot be found or fails to initialize.
    setup_message: str
    #: Exact child-env keys forwarded to the agent (never the whole env).
    env_exact: frozenset[str]
    #: Child-env key prefixes forwarded to the agent.
    env_prefixes: tuple[str, ...] = ()
    #: Model catalog used when the agent advertises no model config option.
    default_models: tuple[ModelInfo, ...] = ()
    default_timeout_ms: int = 120_000
    #: `configOptions` id carrying the model selector.
    model_config_id: str = "model"
    #: Value used for `session/set_config_option` when switching models.
    display_name: str | None = None
    #: Fixed executable (custom providers) — used verbatim when set.
    command: str | None = None


def merge_child_env_extra(
    extra: Mapping[str, Sequence[str]] | None,
) -> tuple[frozenset[str], tuple[str, ...]]:
    """Split a test-only `{keys, prefixes}` extra into exact keys + prefixes."""

    if not extra:
        return frozenset(), ()
    return frozenset(extra.get("keys", ())), tuple(extra.get("prefixes", ()))


def build_acp_child_env(
    config: AcpAgentConfig,
    env: Mapping[str, str],
    extra: Mapping[str, Sequence[str]] | None = None,
) -> dict[str, str]:
    """Forward only allowlisted variables — never the full environment."""

    extra_keys, extra_prefixes = merge_child_env_extra(extra)
    keys = config.env_exact | extra_keys
    prefixes = config.env_prefixes + extra_prefixes
    return {
        key: value
        for key, value in env.items()
        if value is not None and (key in keys or key.startswith(prefixes))
    }
