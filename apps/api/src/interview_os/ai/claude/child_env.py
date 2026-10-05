"""Environment for Claude Code child processes (port of `claude/childEnv.ts`)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

__all__ = ["build_claude_child_env"]

EXACT_ALLOWLIST = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "CLAUDE_AGENT_SDK_CLIENT_APP",
    }
)

PREFIX_ALLOWLIST = ("XDG_", "ANTHROPIC_")


def build_claude_child_env(
    env: Mapping[str, str],
    extra: Mapping[str, Sequence[str]] | None = None,
) -> dict[str, str]:
    """Forward only allowlisted variables — never the full environment."""

    keys = EXACT_ALLOWLIST | set(extra.get("keys", ()) if extra else ())
    prefixes = PREFIX_ALLOWLIST + tuple(extra.get("prefixes", ()) if extra else ())
    return {
        key: value
        for key, value in env.items()
        if value is not None and (key in keys or key.startswith(prefixes))
    }
