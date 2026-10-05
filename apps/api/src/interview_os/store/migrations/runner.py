"""Programmatic Alembic entry point used by `Store.migrate()`.

`alembic upgrade head` is the only schema creator; the env script handles the
auto-stamp for databases that already contain the application tables.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

MIGRATIONS_DIR = Path(__file__).resolve().parent
ALEMBIC_INI = MIGRATIONS_DIR / "alembic.ini"


def alembic_config(db_path: str | Path) -> Config:
    config = Config(str(ALEMBIC_INI))
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{Path(db_path).as_posix()}")
    # Server startup migrates silently; the CLI keeps the INFO output.
    config.attributes["quiet"] = True
    return config


def upgrade_to_head(db_path: str | Path) -> None:
    command.upgrade(alembic_config(db_path), "head")
