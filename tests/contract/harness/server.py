"""Backend launcher for the contract suite.

Spawns the current Hono backend (`node --import tsx apps/server/src/index.ts`)
on a throwaway SQLite DB, or returns an already-running server when
INTERVIEW_OS_BASE_URL is set. CONTRACT_BACKEND selects the implementation:
"hono" (default) or "fastapi" (reserved; the port does not exist yet).
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
FAKE_MCP_SERVER = REPO_ROOT / "tests" / "fixtures" / "fake-mcp-server.mjs"

READY_TIMEOUT_S = 120.0
READY_POLL_S = 0.25
STOP_GRACE_S = 5.0
LOG_TAIL_LINES = 50

# Every spawned server's tmpdir — used to mask tmp paths in snapshots.
SPAWNED_TMPDIRS: list[Path] = []


@dataclass
class ServerHandle:
    base_url: str
    proc: subprocess.Popen | None
    tmpdir: Path
    log_path: Path | None = field(default=None)
    _log_file: object | None = field(default=None, repr=False)

    @property
    def spawned(self) -> bool:
        return self.proc is not None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _server_env(tmpdir: Path, port: int) -> dict[str, str]:
    # Strip inherited INTERVIEW_OS_* so the host shell cannot leak config
    # (runtime selection, db path, test mode) into the spawned backend.
    env = {k: v for k, v in os.environ.items() if not k.startswith("INTERVIEW_OS_")}
    tmpdir.mkdir(parents=True, exist_ok=True)
    (tmpdir / "installed-plugins").mkdir(exist_ok=True)
    (tmpdir / "installed-packs").mkdir(exist_ok=True)

    node = shutil.which("node")
    if node is None:
        raise pytest.UsageError("node executable not found on PATH")
    (tmpdir / "mcp.json").write_text(
        json.dumps(
            {
                "servers": [
                    {
                        "id": "fake",
                        "name": "Fake MCP",
                        "command": node,
                        "args": [str(FAKE_MCP_SERVER)],
                        "envPassthrough": [],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    env.update(
        {
            "INTERVIEW_OS_RUNTIME": "mock",
            "INTERVIEW_OS_DB": str(tmpdir / "contract.db"),
            "INTERVIEW_OS_HOST": "127.0.0.1",
            "INTERVIEW_OS_PORT": str(port),
            "INTERVIEW_OS_TEST_MODE": "1",
            "INTERVIEW_OS_MOCK_DELAY_MS": "0",
            # Installed content goes to tmp dirs; bundled plugins/packs use the
            # repo defaults (plugins/, packs/).
            "INTERVIEW_OS_INSTALLED_PLUGINS_DIR": str(tmpdir / "installed-plugins"),
            "INTERVIEW_OS_INSTALLED_PACKS_DIR": str(tmpdir / "installed-packs"),
            "INTERVIEW_OS_MCP_CONFIG": str(tmpdir / "mcp.json"),
            "INTERVIEW_OS_RUNTIMES_CONFIG": str(tmpdir / "runtimes.missing.json"),
        }
    )
    return env


def tail_log(log_path: Path | None, lines: int = LOG_TAIL_LINES) -> str:
    if log_path is None or not log_path.exists():
        return "<no server log>"
    try:
        tail = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
    except OSError as exc:
        return f"<unreadable server log: {exc}>"
    return "\n".join(tail)


def _spawn_hono(tmpdir: Path) -> ServerHandle:
    port = _free_port()
    log_path = tmpdir / "server.log"
    log_file = log_path.open("w", encoding="utf-8", errors="replace")
    node = shutil.which("node")
    if node is None:
        raise pytest.UsageError("node executable not found on PATH")
    proc = subprocess.Popen(
        [node, "--import", "tsx", "apps/server/src/index.ts"],
        cwd=REPO_ROOT,
        env=_server_env(tmpdir, port),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        shell=False,
    )
    return ServerHandle(
        base_url=f"http://127.0.0.1:{port}",
        proc=proc,
        tmpdir=tmpdir,
        log_path=log_path,
        _log_file=log_file,
    )


def _spawn_fastapi(tmpdir: Path) -> ServerHandle:
    port = _free_port()
    log_path = tmpdir / "server.log"
    log_file = log_path.open("w", encoding="utf-8", errors="replace")
    api_dir = REPO_ROOT / "apps" / "api"
    proc = subprocess.Popen(
        [
            "uv",
            "run",
            "--project",
            str(api_dir),
            "uvicorn",
            "interview_os.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=str(api_dir),
        env=_server_env(tmpdir, port),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        shell=False,
    )
    return ServerHandle(
        base_url=f"http://127.0.0.1:{port}",
        proc=proc,
        tmpdir=tmpdir,
        log_path=log_path,
        _log_file=log_file,
    )


def wait_ready(handle: ServerHandle, timeout_s: float = READY_TIMEOUT_S) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if handle.proc is not None and handle.proc.poll() is not None:
            raise pytest.UsageError(
                f"backend exited with code {handle.proc.returncode} during startup\n"
                f"--- last {LOG_TAIL_LINES} log lines ---\n{tail_log(handle.log_path)}"
            )
        try:
            resp = httpx.get(f"{handle.base_url}/api/runtime/status", timeout=5.0)
            if resp.status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(READY_POLL_S)
    raise pytest.UsageError(
        f"backend did not become ready within {timeout_s:.0f}s\n"
        f"--- last {LOG_TAIL_LINES} log lines ---\n{tail_log(handle.log_path)}"
    )


def stop_server(handle: ServerHandle) -> None:
    if handle.proc is None:
        return
    handle.proc.terminate()
    try:
        handle.proc.wait(timeout=STOP_GRACE_S)
    except subprocess.TimeoutExpired:
        handle.proc.kill()
        handle.proc.wait(timeout=STOP_GRACE_S)
    if handle._log_file is not None:
        try:
            handle._log_file.close()
        except OSError:
            pass


def launch_server(tmpdir: Path) -> ServerHandle:
    """Spawn the configured backend, wait for readiness, return the handle."""
    external = os.environ.get("INTERVIEW_OS_BASE_URL")
    if external:
        return ServerHandle(base_url=external.rstrip("/"), proc=None, tmpdir=tmpdir)

    backend = os.environ.get("CONTRACT_BACKEND", "hono")
    handle = _spawn_fastapi(tmpdir) if backend == "fastapi" else _spawn_hono(tmpdir)
    if backend not in ("hono", "fastapi"):
        raise pytest.UsageError(f"unknown CONTRACT_BACKEND {backend!r} (expected 'hono' or 'fastapi')")
    SPAWNED_TMPDIRS.append(handle.tmpdir)
    try:
        wait_ready(handle)
    except Exception:
        stop_server(handle)
        raise
    return handle
