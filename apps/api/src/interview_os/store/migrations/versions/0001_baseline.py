"""Baseline revision: the exact DDL the TypeScript server creates.

`BASELINE_DDL` is captured from `sqlite_master` of a freshly booted
`apps/server`, so a database created here is byte-compatible with the one the
Hono backend creates — including the column order produced by its incremental
`ALTER TABLE` upgrades. `env.py` stamps this revision (instead of running it)
when the tables already exist.
"""

from __future__ import annotations

from alembic import op

from interview_os.store.schema import BASELINE_DDL, TABLE_NAMES

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    for statement in BASELINE_DDL:
        op.execute(statement)


def downgrade() -> None:
    for table in reversed(TABLE_NAMES):
        op.execute(f'DROP TABLE IF EXISTS "{table}"')
