"""Environment for Codex child processes (port of `codex/childEnv.ts`)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

__all__ = ["build_child_env"]

EXACT_ALLOWLIST = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "CODEX_HOME",
        "OPENAI_API_KEY",
    }
)

PREFIX_ALLOWLIST = ("XDG_",)


def build_child_env(
    env: Mapping[str, str],
    extra: Mapping[str, Sequence[str]] | None = None,
) -> dict[str, str]:
    """Forward only allowlisted variables — never the full environment.

    `extra["keys"]`/`extra["prefixes"]` exist for tests (e.g. the fake-codex
    fixture).
    """

    keys = EXACT_ALLOWLIST | set(extra.get("keys", ()) if extra else ())
    prefixes = PREFIX_ALLOWLIST + tuple(extra.get("prefixes", ()) if extra else ())
    return {
        key: value
        for key, value in env.items()
        if value is not None and (key in keys or key.startswith(prefixes))
    }
