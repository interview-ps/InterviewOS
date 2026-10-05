"""Child-process helpers: launch specs, argv-only spawning, timeouts."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from interview_os.ai import (
    RuntimeError,
    exec_file_safe,
    launch_spec,
    node_executable,
    quote_windows_arg,
    run_cli,
    spawn_command,
)


def test_launch_spec_passes_plain_binaries_through() -> None:
    spec = launch_spec("/usr/bin/tool", ["--flag", "value"])
    assert spec.command == "/usr/bin/tool"
    assert spec.args == ["--flag", "value"]


def test_launch_spec_runs_node_scripts_through_node() -> None:
    spec = launch_spec("fake.mjs", ["exec", "--json"])
    assert Path(spec.command).name.lower().startswith("node")
    assert spec.args == ["fake.mjs", "exec", "--json"]


def test_launch_spec_node_override_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERVIEW_OS_NODE_BIN", "/opt/node")
    assert launch_spec("fake.cjs", []).command == "/opt/node"


def test_launch_spec_windows_shim_uses_comspec(monkeypatch: pytest.MonkeyPatch) -> None:
    if os.name != "nt":
        pytest.skip("cmd.exe shims only exist on Windows")
    monkeypatch.setenv("ComSpec", "cmd.exe")
    spec = launch_spec("C:/bin/codex.cmd", ["exec", "-"])
    assert spec.command == "cmd.exe"
    assert spec.args[0:3] == ["/d", "/s", "/c"]
    assert spec.args[3] == "C:/bin/codex.cmd exec -"


def test_quote_windows_arg_quotes_only_when_needed() -> None:
    assert quote_windows_arg("plain") == "plain"
    assert quote_windows_arg("") == '""'
    assert quote_windows_arg("has space") == '"has space"'
    assert quote_windows_arg('say "hi"') == '"say ""hi"""'


def test_node_executable_resolves_from_path() -> None:
    assert Path(node_executable()).exists()


async def test_spawn_command_keeps_argv_arrays() -> None:
    proc = await spawn_command(sys.executable, ["-c", "print('hi')"])
    stdout, _stderr = await proc.communicate()
    assert proc.returncode == 0
    assert stdout.decode().strip() == "hi"


async def test_spawn_command_reports_a_missing_binary() -> None:
    with pytest.raises(OSError):
        await spawn_command("/nonexistent/binary-xyz", [])


async def test_run_cli_collects_output_and_code() -> None:
    result = await run_cli(sys.executable, ["-c", "print('out')"], timeout_ms=10_000)
    assert (result.code, result.stderr) == (0, "")
    assert result.stdout.strip() == "out"


async def test_run_cli_reports_a_failed_spawn_as_code_none() -> None:
    result = await run_cli("/nonexistent/binary-xyz", [], timeout_ms=1_000)
    assert result.code is None
    assert result.stdout == ""
    assert result.stderr != ""


async def test_run_cli_kills_a_hung_process() -> None:
    result = await run_cli(
        sys.executable,
        ["-c", "import time; time.sleep(60)"],
        timeout_ms=300,
    )
    assert result.code is None


async def test_run_cli_writes_stdin_without_argv() -> None:
    result = await run_cli(
        sys.executable,
        ["-c", "import sys; sys.stdout.write(sys.stdin.read().upper())"],
        stdin="secret prompt",
        timeout_ms=10_000,
    )
    assert result.stdout == "SECRET PROMPT"


async def test_exec_file_safe_degrades_instead_of_raising() -> None:
    result = await exec_file_safe("/nonexistent/binary-xyz", ["--version"], timeout_ms=1_000)
    assert result.code is None


async def test_exec_file_safe_uses_the_allowlisted_env() -> None:
    result = await exec_file_safe(
        sys.executable,
        ["-c", "import os; print(os.environ.get('SECRET_TOKEN', 'missing'))"],
        env={"PATH": os.environ.get("PATH", "")},
        timeout_ms=10_000,
    )
    assert result.stdout.strip() == "missing"


def test_runtime_error_shadows_the_builtin() -> None:
    import builtins

    assert RuntimeError is not builtins.__dict__["RuntimeError"]
    error = RuntimeError("TIMEOUT", "timed out")
    assert (error.code, error.message, str(error)) == ("TIMEOUT", "timed out", "timed out")
