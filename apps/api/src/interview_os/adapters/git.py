"""Git install adapters — port of `apps/server/src/adapters/git.ts`.

Sources are untrusted input: they are validated before use, passed as argv
arrays (never a shell string), and never logged.
"""

from __future__ import annotations

import asyncio
import ntpath
import os
import posixpath
from pathlib import Path
from urllib.parse import urlparse

from ..core.models import AppError

__all__ = ["clone_shallow", "validate_git_source"]

CLONE_TIMEOUT_SECONDS = 120.0


def validate_git_source(url: str, code: str = "PLUGIN_INSTALL") -> None:
    """Validate an install source: an https URL without credentials or an
    absolute local path. Never logged — callers must keep the URL out of log
    lines."""

    if not url or url.startswith("-") or url.startswith("ext::"):
        raise AppError(code, "invalid git source")
    if ntpath.isabs(url) or posixpath.isabs(url):
        return
    parsed = urlparse(url)
    if not parsed.scheme:
        raise AppError(code, "source must be an https URL or a local path")
    if parsed.scheme != "https" or parsed.username is not None or parsed.password is not None:
        raise AppError(code, "source must be an https URL without credentials")


async def clone_shallow(url: str, dest: str | Path, code: str = "PLUGIN_INSTALL") -> None:
    """Shallow-clone `url` into `dest`. URL must already pass `validate_git_source`.
    No prompts, no interactive auth, bounded output; argv array, never a shell."""

    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    argv = [
        "git",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--depth",
        "1",
        "--no-recurse-submodules",
        "--",
        url,
        str(dest),
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            env=env,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(process.wait(), timeout=CLONE_TIMEOUT_SECONDS)
        except TimeoutError as err:
            process.kill()
            await process.wait()
            raise AppError(code, "git clone failed") from err
    except OSError as err:
        raise AppError(code, "git clone failed") from err
    if process.returncode != 0:
        raise AppError(code, "git clone failed")
