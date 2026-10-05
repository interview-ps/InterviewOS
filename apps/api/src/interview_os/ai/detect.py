"""Provider detection probes shared by the four CLI runtimes.

Port of the per-provider `detect.ts` files in `packages/runtime/src/{codex,
claude,opencode,devin}` — the PATH scan, the `INTERVIEW_OS_<KIND>_BIN`
override, and the `--version` probe are identical, so they live here once.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping, Sequence

from .process import exec_file_safe

__all__ = [
    "candidate_names",
    "find_executable",
    "probe_version",
]

VERSION_RE = re.compile(r"(\d+\.\d+\.\d+[^\s]*)")


def candidate_names(unix: str, windows: Sequence[str]) -> list[str]:
    """Executable names to look for, in order, per platform."""

    return list(windows) if os.name == "nt" else [unix]


async def find_executable(
    env: Mapping[str, str],
    *,
    override_key: str,
    names: Sequence[str],
) -> str | None:
    """Resolve a provider binary: explicit override, else a `PATH` scan."""

    override = env.get(override_key)
    if override:
        return override if os.access(override, os.X_OK) else None
    for directory in env.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        for name in names:
            candidate = os.path.join(directory, name)
            if os.access(candidate, os.X_OK):
                return candidate
    return None


async def probe_version(
    bin: str,
    *,
    env: Mapping[str, str] | None = None,
    pattern: re.Pattern[str] = VERSION_RE,
    timeout_ms: int = 5000,
) -> str | None:
    """`<bin> --version`; `None` when the probe fails or times out."""

    result = await exec_file_safe(bin, ["--version"], env=env, timeout_ms=timeout_ms)
    if result.code != 0:
        return None
    match = pattern.search(f"{result.stdout}\n{result.stderr}")
    return match.group(1) if match else None
