"""Environment for `devin` child processes (port of `devin/childEnv.ts`)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

__all__ = ["build_devin_child_env"]

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
        # Windows: the Devin CLI reads credentials/config under these roots.
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "WINDSURF_API_KEY",
    }
)

PREFIX_ALLOWLIST = ("XDG_", "DEVIN_")


def build_devin_child_env(
    env: Mapping[str, str],
    extra: Mapping[str, Sequence[str]] | None = None,
) -> dict[str, str]:
    """Forward only allowlisted variables — no tokens from this process.

    Devin credentials are read by the CLI from its own auth store
    (`devin auth login`).
    """

    keys = EXACT_ALLOWLIST | set(extra.get("keys", ()) if extra else ())
    prefixes = PREFIX_ALLOWLIST + tuple(extra.get("prefixes", ()) if extra else ())
    return {
        key: value
        for key, value in env.items()
        if value is not None and (key in keys or key.startswith(prefixes))
    }
