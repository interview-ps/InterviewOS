"""Environment for `opencode` child processes (port of `opencode/childEnv.ts`)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

__all__ = ["build_opencode_child_env"]

EXACT_ALLOWLIST = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "OPENCODE_CONFIG",
    }
)

PREFIX_ALLOWLIST = ("XDG_", "OPENCODE_")


def build_opencode_child_env(
    env: Mapping[str, str],
    extra: Mapping[str, Sequence[str]] | None = None,
) -> dict[str, str]:
    """Forward only allowlisted variables — provider keys are not forwarded.

    opencode reads provider credentials from its own auth store, so they are
    deliberately left out of this process's environment.
    """

    keys = EXACT_ALLOWLIST | set(extra.get("keys", ()) if extra else ())
    prefixes = PREFIX_ALLOWLIST + tuple(extra.get("prefixes", ()) if extra else ())
    return {
        key: value
        for key, value in env.items()
        if value is not None and (key in keys or key.startswith(prefixes))
    }
