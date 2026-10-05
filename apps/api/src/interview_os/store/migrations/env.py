"""Alembic environment for the Interview OS SQLite database.

The baseline revision is the authoritative fresh-database creator. A database
that already contains the application tables (any pre-port `data/*.db`) is
**stamped** with the baseline instead of being recreated — the TypeScript
server and the Python store must keep sharing one file.
"""

from __future__ import annotations

import logging
import os
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, pool
from sqlalchemy.engine import Connection

from interview_os.paths import DEFAULT_DB_PATH
from interview_os.store.schema import TABLE_NAMES, Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

if config.attributes.get("quiet"):
    logging.getLogger("alembic").setLevel(logging.WARNING)

target_metadata = Base.metadata


def database_url() -> str:
    url = config.get_main_option("sqlalchemy.url") or ""
    if url:
        return url
    configured = os.environ.get("INTERVIEW_OS_DB")
    path = Path(configured) if configured else DEFAULT_DB_PATH
    return f"sqlite:///{path.as_posix()}"


def _engine() -> object:
    return create_engine(database_url(), poolclass=pool.NullPool)


def _has_app_tables(connection: Connection) -> bool:
    return bool(set(inspect(connection).get_table_names()) & set(TABLE_NAMES))


def _stamp_baseline_if_present(connection: Connection) -> None:
    """A database that already has the tables is at the baseline, not before it."""

    migration_context = MigrationContext.configure(connection)
    if migration_context.get_current_revision() is not None:
        return
    if not _has_app_tables(connection):
        return
    migration_context.stamp(ScriptDirectory.from_config(config), "head")
    connection.commit()


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = _engine()
    with connectable.connect() as connection:  # type: ignore[attr-defined]
        _stamp_baseline_if_present(connection)
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
        # SQLite DDL is non-transactional, so Alembic's version row needs an
        # explicit commit or the next open would re-run the baseline.
        connection.commit()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
