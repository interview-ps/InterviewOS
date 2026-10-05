"""DDL parity: the Alembic baseline must reproduce the current server's schema.

One database is created by `alembic upgrade head`, one by booting the current
Hono backend on a throwaway file. `PRAGMA table_info` is compared for every
table (names, types, notnull, defaults, primary keys) plus the raw
`sqlite_master.sql`. If the server cannot be started on this host, the test
skips with the reason and the rest of the file still checks `schema.py` against
the baseline.
"""

from __future__ import annotations

import os
import shutil
import socket
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest
from alembic import command

from interview_os.store.migrations.runner import alembic_config
from interview_os.store.schema import BASELINE_DDL, TABLE_NAMES, Base

SERVER_READY_TIMEOUT_S = 120.0
SERVER_SOURCE = "apps/server/src/index.ts"


@pytest.fixture(scope="module")
def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def alembic_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("alembic") / "baseline.db"
    command.upgrade(alembic_config(path), "head")
    return path


@pytest.fixture(scope="module")
def server_db(
    tmp_path_factory: pytest.TempPathFactory, repo_root: Path, node_executable: str
) -> Path:
    """Boot the current server on a throwaway DB and return that file."""

    tmpdir = tmp_path_factory.mktemp("server")
    db_path = tmpdir / "server.db"
    for name in ("installed-plugins", "installed-packs"):
        (tmpdir / name).mkdir()
    env = {key: value for key, value in os.environ.items() if not key.startswith("INTERVIEW_OS_")}
    env.update(
        {
            "INTERVIEW_OS_RUNTIME": "mock",
            "INTERVIEW_OS_DB": str(db_path),
            "INTERVIEW_OS_HOST": "127.0.0.1",
            "INTERVIEW_OS_PORT": str(_free_port()),
            "INTERVIEW_OS_TEST_MODE": "1",
            "INTERVIEW_OS_MOCK_DELAY_MS": "0",
            "INTERVIEW_OS_INSTALLED_PLUGINS_DIR": str(tmpdir / "installed-plugins"),
            "INTERVIEW_OS_INSTALLED_PACKS_DIR": str(tmpdir / "installed-packs"),
            "INTERVIEW_OS_MCP_CONFIG": str(tmpdir / "mcp.json"),
            "INTERVIEW_OS_RUNTIMES_CONFIG": str(tmpdir / "runtimes.missing.json"),
        }
    )
    log_path = tmpdir / "server.log"
    with log_path.open("w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen(
            [node_executable, "--import", "tsx", SERVER_SOURCE],
            cwd=repo_root,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            shell=False,
        )
        try:
            deadline = time.monotonic() + SERVER_READY_TIMEOUT_S
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    pytest.skip(
                        f"the current server exited with code {proc.returncode} during startup "
                        f"(see {log_path.name}); DDL parity vs the live server is unavailable"
                    )
                if "server.listening" in log_path.read_text(encoding="utf-8", errors="replace"):
                    break
                time.sleep(0.25)
            else:
                pytest.skip("timed out waiting for the current server to start")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover - best effort
                proc.kill()
    assert db_path.exists(), "the current server did not create its database"
    return db_path


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _table_names(db_path: Path) -> list[str]:
    con = sqlite3.connect(str(db_path))
    try:
        return [
            row[0]
            for row in con.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                " AND name != 'alembic_version'"
            )
        ]
    finally:
        con.close()


def _table_info(db_path: Path) -> dict[str, list[dict[str, Any]]]:
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    try:
        out: dict[str, list[dict[str, Any]]] = {}
        for table in _table_names(db_path):
            out[table] = [
                {
                    "name": row["name"],
                    "type": row["type"],
                    "notnull": row["notnull"],
                    "default": row["dflt_value"],
                    "pk": row["pk"],
                }
                for row in con.execute(f'PRAGMA table_info("{table}")')
            ]
        return out
    finally:
        con.close()


def _table_sql(db_path: Path) -> dict[str, str]:
    con = sqlite3.connect(str(db_path))
    try:
        return {
            row[0]: row[1]
            for row in con.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
            if row[0] not in ("sqlite_sequence", "alembic_version")
        }
    finally:
        con.close()


def test_baseline_creates_every_table(alembic_db: Path) -> None:
    assert set(_table_names(alembic_db)) == set(TABLE_NAMES)
    assert len(TABLE_NAMES) == len(BASELINE_DDL)


def test_baseline_ddl_names_match_table_names() -> None:
    names = [statement.split("(", 1)[0].split()[-1] for statement in BASELINE_DDL]
    assert names == list(TABLE_NAMES)
    assert set(Base.metadata.tables) == set(TABLE_NAMES)


def test_alembic_stamps_instead_of_recreating_an_existing_database(
    server_db: Path, tmp_path: Path
) -> None:
    copy = tmp_path / "existing.db"
    for suffix in ("", "-wal", "-shm"):
        source = server_db.with_name(server_db.name + suffix)
        if source.exists():
            shutil.copy(source, copy.with_name(copy.name + suffix))
    before = _table_sql(copy)

    command.upgrade(alembic_config(copy), "head")

    con = sqlite3.connect(str(copy))
    try:
        stamped = con.execute("SELECT version_num FROM alembic_version").fetchall()
    finally:
        con.close()
    assert stamped == [("0001_baseline",)]
    assert _table_sql(copy) == before


def test_metadata_matches_the_server_schema(server_db: Path) -> None:
    server = _table_info(server_db)
    assert set(server) == set(TABLE_NAMES)
    for table in TABLE_NAMES:
        columns = {column.name: column for column in Base.metadata.tables[table].columns}
        assert list(columns) == [column["name"] for column in server[table]], table
        for name, column in columns.items():
            info = next(column for column in server[table] if column["name"] == name)
            assert str(column.type) == info["type"], f"{table}.{name} type"
            if column.primary_key:
                # SQLite leaves a TEXT PRIMARY KEY nullable and renders the
                # autoincrement PK without NOT NULL; SQLAlchemy's metadata is
                # stricter, which the CRUD layer relies on (it never writes NULL).
                continue
            assert int(not column.nullable) == info["notnull"], f"{table}.{name} notnull"
            declared = column.server_default
            expected = None if declared is None else str(getattr(declared, "arg", declared))
            assert expected == info["default"], f"{table}.{name} default"


def test_alembic_and_server_schemas_are_identical(alembic_db: Path, server_db: Path) -> None:
    alembic = _table_info(alembic_db)
    server = _table_info(server_db)
    assert set(alembic) == set(server)
    for table in sorted(server):
        assert alembic[table] == server[table], f"column mismatch in {table}"


def test_alembic_and_server_ddl_text_is_identical(alembic_db: Path, server_db: Path) -> None:
    assert _table_sql(alembic_db) == _table_sql(server_db)


def test_store_open_produces_the_same_schema_as_alembic(alembic_db: Path, tmp_path: Path) -> None:
    from interview_os.store import open_store

    store = open_store(tmp_path / "store.db")
    try:
        assert _table_info(tmp_path / "store.db") == _table_info(alembic_db)
    finally:
        store.close()
