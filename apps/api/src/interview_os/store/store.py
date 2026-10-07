"""Mechanical data access over the shared SQLite database.

Port of `apps/server/src/orchestrator/store/index.ts`: one cohesive `Store`
(no repository split), typed helpers for the tables the domain flows need and
thin generic row access for the rest. JSON columns are `TEXT` and are
serialized/deserialized with the Pydantic models from `interview_os.core`; a
row that fails validation raises `StoreDataError` instead of being dropped.

Readiness snapshots are append-only (`append_readiness_snapshot`).
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from pydantic import BaseModel, TypeAdapter, ValidationError
from sqlalchemy import Engine, create_engine, delete, insert, select, text, update
from sqlalchemy.engine import Connection
from sqlalchemy.pool import StaticPool

from ..core.models import (
    AnswerEvaluation,
    AnswerEvaluationRow,
    CamelModel,
    CandidateAnswerRow,
    CandidateProfile,
    CandidateProfileRow,
    ExpectedConcept,
    ExternalContextRow,
    InterviewDebriefRow,
    InterviewLoopRow,
    InterviewPackRow,
    InterviewQuestionRow,
    InterviewSessionRow,
    JsonScalar,
    ModeState,
    Permission,
    PreparationActionRow,
    PrepResource,
    ReadinessScoreRow,
    ResumeReviewRow,
    SkillEvidenceRow,
    StarStoryRow,
    TargetRole,
    TargetRoleRow,
    UserQuestionRow,
    VoiceFeedback,
    VoiceMetrics,
)
from ..core.skill_id import SkillId
from .schema import BASELINE_DDL, TABLE_NAMES, Base

__all__ = [
    "APPEND_ONLY_TABLES",
    "AIUsageRow",
    "AnswerPluginReview",
    "AnswerRow",
    "AnswerVoice",
    "CandidateRow",
    "EvaluationRow",
    "EvidenceRow",
    "McpServerRow",
    "PluginInstallRow",
    "PluginSettingRow",
    "PluginStorageRow",
    "PrepActionRow",
    "QuestionRow",
    "ReadinessDeltaEntry",
    "ReadinessRow",
    "RuntimeSessionRow",
    "SessionRow",
    "Store",
    "StoreDataError",
    "TargetRow",
    "open_store",
]

_MEMORY = ":memory:"

# Invariant #3: readiness snapshots are appended, never overwritten.
APPEND_ONLY_TABLES = ("readiness_scores", "ai_usage")


class StoreDataError(Exception):
    """A stored row does not match its model — fail loudly, never drop data."""

    def __init__(self, table: str, column: str, detail: str) -> None:
        super().__init__(f"{table}.{column}: {detail}")
        self.table = table
        self.column = column
        self.detail = detail


# --------------------------------------------------------------- row models


class ReadinessDeltaEntry(CamelModel):
    """`answer_evaluations.readiness_delta` entry: per-skill before→after (§9.7)."""

    skill_id: SkillId
    before: float | None
    after: float | None


class AnswerVoice(CamelModel):
    """`candidate_answers.voice`: client metrics + recomputed delivery feedback."""

    metrics: VoiceMetrics
    feedback: VoiceFeedback


class AnswerPluginReview(CamelModel):
    """`candidate_answers.plugin_reviews` entry from evaluation.review hooks."""

    plugin_id: str
    plugin_name: str
    observations: list[Any]


class CandidateRow(CamelModel):
    id: str
    active: int
    name: str | None
    headline: str | None
    resume_text: str
    data: CandidateProfile
    created_at: str


class TargetRow(CamelModel):
    id: str
    active: int
    company: str
    role: str
    level: str
    job_description: str
    data: TargetRole
    created_at: str


class SessionRow(CamelModel):
    id: str
    candidate_id: str | None
    target_id: str | None
    status: str
    current_round: int
    planned_questions: int
    mode: str
    round_type: str
    focus_skill_id: str | None
    action_id: str | None
    mode_state: ModeState
    loop_id: str | None
    loop_round: int | None
    context_id: str | None
    focus_skills: list[SkillId]
    created_at: str
    completed_at: str | None
    plugin_mode_id: str | None


class QuestionRow(CamelModel):
    id: str
    session_id: str
    skill_id: str
    topic: str
    text: str
    sub_skills: list[SkillId]
    expected_concepts: list[ExpectedConcept]
    difficulty: str
    selection_priority: float | None
    selection_reason: str | None
    selection_factors: dict[str, Any]
    follow_up_of: str | None
    follow_up_focus: str | None
    extra: dict[str, Any]
    position: int
    created_at: str


class AnswerRow(CamelModel):
    id: str
    question_id: str
    session_id: str
    text: str
    code: str | None
    language: str | None
    status: str
    created_at: str
    voice: AnswerVoice | None
    plugin_reviews: list[AnswerPluginReview] | None
    fields: dict[str, JsonScalar] | None


class EvaluationRow(CamelModel):
    id: str
    answer_id: str
    question_id: str
    session_id: str
    data: AnswerEvaluation
    readiness_delta: list[ReadinessDeltaEntry]
    created_at: str


class EvidenceRow(CamelModel):
    id: str
    candidate_id: str | None
    skill_id: str
    type: str
    score: float
    confidence: float
    observation: str
    session_id: str | None
    question_id: str | None
    source: str | None
    created_at: str


class ReadinessRow(CamelModel):
    id: int
    skill_id: str
    score: float | None
    confidence: float
    evidence_ids: list[str]
    reason: str
    computed_at: str


class PrepActionRow(CamelModel):
    id: str
    skill_id: str
    target_id: str | None
    priority: float
    reason: str
    action: str
    success_criteria: list[str]
    status: str
    severity: str
    created_at: str
    source_evidence_ids: list[str]
    resources: list[PrepResource]
    source: str


class RuntimeSessionRow(CamelModel):
    id: str
    session_id: str
    runtime: str
    runtime_session_id: str
    thread_id: str
    status: str
    created_at: str


class AIUsageRow(CamelModel):
    """One append-only `ai_usage` row (numbers and ids only)."""

    id: str
    runtime_kind: str
    provider_session_id: str | None
    interview_session_id: str | None
    task_id: str | None
    model: str | None
    attempt: int | None
    ok: int | None
    error_code: str | None
    input_tokens: int | None
    output_tokens: int | None
    thought_tokens: int | None
    cached_read_tokens: int | None
    cached_write_tokens: int | None
    total_tokens: int | None
    context_used: int | None
    context_size: int | None
    cost_amount: float | None
    cost_currency: str | None
    stop_reason: str | None
    duration_ms: int
    created_at: str


class McpServerRow(CamelModel):
    """`mcp_servers` state (the command lives only in `interview-os.mcp.json`)."""

    id: str
    enabled: int
    allowed_tools: list[str]
    updated_at: str | None


class PluginInstallRow(CamelModel):
    """`plugin_installs` — one row per bundled/installed plugin."""

    id: str
    enabled: int
    granted_permissions: list[Permission]
    source: str
    source_url: str | None
    dir_name: str | None
    installed_at: str | None
    updated_at: str | None


class PluginSettingRow(CamelModel):
    """`plugin_settings` — one declared setting value (JSON) per plugin/key."""

    plugin_id: str
    key: str
    value: Any


class PluginStorageRow(CamelModel):
    """`plugin_storage` — plugin-owned KV rows (JSON), wiped on uninstall."""

    plugin_id: str
    key: str
    value: Any


_STR_LIST = TypeAdapter(list[str])
_PERMISSION_LIST = TypeAdapter(list[Permission])
_SKILL_LIST = TypeAdapter(list[SkillId])
_CONCEPT_LIST = TypeAdapter(list[ExpectedConcept])
_RESOURCE_LIST = TypeAdapter(list[PrepResource])
_DELTA_LIST = TypeAdapter(list[ReadinessDeltaEntry])
_REVIEW_LIST = TypeAdapter(list[AnswerPluginReview])
_MODE_STATE = TypeAdapter(ModeState)
_FACTORS = TypeAdapter(dict[str, Any])
_FIELDS = TypeAdapter(dict[str, JsonScalar])
_ANY = TypeAdapter(Any)
_ROUND_LIST = TypeAdapter(list[Any])


def _load(adapter: TypeAdapter[Any], raw: Any, table: str, column: str) -> Any:
    if raw is None:
        return None
    try:
        return adapter.validate_json(raw)
    except ValidationError as exc:
        raise StoreDataError(table, column, str(exc)) from exc


def _load_model(model: type[BaseModel], raw: Any, table: str, column: str) -> Any:
    if raw is None:
        return None
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        raise StoreDataError(table, column, str(exc)) from exc


def _jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True)
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    return value


def _dump(value: Any) -> str:
    """Serialize a JSON column the way `JSON.stringify` does (compact, UTF-8)."""

    return json.dumps(_jsonable(value), separators=(",", ":"), ensure_ascii=False)


# ------------------------------------------------------------------- store


class _TxState:
    """Transaction depth + the connection holding the open transaction.

    Shared between the root store and every store bound to a transaction: the
    database has a single connection, so all of them must use the same one.
    """

    def __init__(self) -> None:
        self.depth = 0
        self.connection: Connection | None = None


class Store:
    """Open, migrate and query the Interview OS SQLite database."""

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._memory = self._path == _MEMORY
        url = "sqlite://" if self._memory else f"sqlite:///{Path(self._path).as_posix()}"
        self._engine: Engine = create_engine(
            url,
            poolclass=StaticPool,
            connect_args={"check_same_thread": False, "isolation_level": None},
        )
        self._tx = _TxState()
        self._conn: Connection | None = None
        if not self._memory:
            self._exec("PRAGMA journal_mode = WAL")
        self.migrate()

    @classmethod
    def _bind(cls, engine: Engine, conn: Connection, tx: _TxState, path: str) -> Store:
        store = cls.__new__(cls)
        store._path = path
        store._memory = False
        store._engine = engine
        store._tx = tx
        store._conn = conn
        return store

    # ------------------------------------------------------------ lifecycle

    def close(self) -> None:
        self._engine.dispose()

    @property
    def path(self) -> str:
        return self._path

    @contextmanager
    def transaction(self) -> Iterator[Store]:
        """Run a block in one SQLite transaction (`BEGIN IMMEDIATE`).

        The yielded store is bound to the transaction connection, so every write
        it makes commits or rolls back together. Nested calls (including through
        the root store, which shares the single connection) use savepoints.
        """

        if self._tx.depth > 0 and self._tx.connection is not None:
            conn = self._tx.connection
            tx_store = (
                self
                if self._conn is not None
                else Store._bind(self._engine, conn, self._tx, self._path)
            )
            self._tx.depth += 1
            name = f"sp_{self._tx.depth}"
            conn.exec_driver_sql(f"SAVEPOINT {name}")
            try:
                yield tx_store
            except BaseException:
                conn.exec_driver_sql(f"ROLLBACK TO SAVEPOINT {name}")
                conn.exec_driver_sql(f"RELEASE SAVEPOINT {name}")
                raise
            else:
                conn.exec_driver_sql(f"RELEASE SAVEPOINT {name}")
            finally:
                self._tx.depth -= 1
            return

        with self._engine.connect() as conn:
            conn.exec_driver_sql("BEGIN IMMEDIATE")
            tx_store = Store._bind(self._engine, conn, self._tx, self._path)
            self._tx.depth = 1
            self._tx.connection = conn
            try:
                yield tx_store
            except BaseException:
                conn.exec_driver_sql("ROLLBACK")
                raise
            else:
                conn.exec_driver_sql("COMMIT")
            finally:
                self._tx.depth = 0
                self._tx.connection = None

    # ------------------------------------------------------------ migration

    def migrate(self) -> None:
        """Create missing tables and apply additive upgrades — idempotent.

        A fresh database is created by the Alembic baseline (the same DDL the
        TypeScript server emits); a database that already has the tables is
        stamped instead of recreated, then older databases get the same additive
        `ALTER TABLE` upgrades the TypeScript store applied on every open.
        """

        if self._memory:
            self._create_missing_tables()
        else:
            from .migrations.runner import upgrade_to_head

            upgrade_to_head(self._path)
            # A pre-existing database (created by an older build) is stamped at
            # head instead of recreated, so tables added to `BASELINE_DDL` after
            # its creation must be created here too (idempotent, additive).
            self._create_missing_tables()
        self._ensure_columns()

    def _create_missing_tables(self) -> None:
        existing = set(self._table_names())
        for statement in BASELINE_DDL:
            if _table_name(statement) not in existing:
                self._exec(statement)

    def _table_names(self) -> list[str]:
        rows = self._query("SELECT name FROM sqlite_master WHERE type = 'table'")
        return [str(row["name"]) for row in rows]

    def _ensure_columns(self) -> None:
        self._add_column(
            "candidate_answers",
            "status",
            "ALTER TABLE candidate_answers ADD COLUMN status TEXT NOT NULL DEFAULT 'evaluated'",
        )
        self._add_column(
            "preparation_actions",
            "severity",
            "ALTER TABLE preparation_actions ADD COLUMN severity TEXT NOT NULL DEFAULT 'medium'",
        )
        self._add_column(
            "interview_sessions",
            "mode",
            "ALTER TABLE interview_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'interview'",
        )
        self._add_column(
            "interview_sessions",
            "focus_skill_id",
            "ALTER TABLE interview_sessions ADD COLUMN focus_skill_id TEXT",
        )
        self._add_column(
            "interview_sessions",
            "action_id",
            "ALTER TABLE interview_sessions ADD COLUMN action_id TEXT",
        )
        self._add_column(
            "preparation_actions",
            "target_id",
            "ALTER TABLE preparation_actions ADD COLUMN target_id TEXT",
        )
        self._add_column(
            "interview_sessions",
            "round_type",
            "ALTER TABLE interview_sessions ADD COLUMN round_type TEXT NOT NULL DEFAULT 'mixed'",
        )
        self._add_column(
            "interview_sessions",
            "mode_state",
            "ALTER TABLE interview_sessions ADD COLUMN mode_state TEXT NOT NULL DEFAULT '{}'",
        )
        self._add_column(
            "interview_questions",
            "selection_factors",
            "ALTER TABLE interview_questions ADD COLUMN selection_factors TEXT NOT NULL"
            " DEFAULT '{}'",
        )
        self._add_column(
            "interview_questions",
            "follow_up_of",
            "ALTER TABLE interview_questions ADD COLUMN follow_up_of TEXT",
        )
        self._add_column(
            "interview_questions",
            "follow_up_focus",
            "ALTER TABLE interview_questions ADD COLUMN follow_up_focus TEXT",
        )
        self._add_column(
            "interview_questions",
            "extra",
            "ALTER TABLE interview_questions ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'",
        )
        self._add_column(
            "candidate_answers", "code", "ALTER TABLE candidate_answers ADD COLUMN code TEXT"
        )
        self._add_column(
            "candidate_answers",
            "language",
            "ALTER TABLE candidate_answers ADD COLUMN language TEXT",
        )
        self._add_column(
            "interview_sessions",
            "loop_id",
            "ALTER TABLE interview_sessions ADD COLUMN loop_id TEXT",
        )
        self._add_column(
            "interview_sessions",
            "loop_round",
            "ALTER TABLE interview_sessions ADD COLUMN loop_round INTEGER",
        )
        self._add_column(
            "answer_evaluations",
            "readiness_delta",
            "ALTER TABLE answer_evaluations ADD COLUMN readiness_delta TEXT NOT NULL DEFAULT '[]'",
        )
        self._add_column(
            "skill_evidence", "source", "ALTER TABLE skill_evidence ADD COLUMN source TEXT"
        )
        self._add_column(
            "interview_loops", "pack_id", "ALTER TABLE interview_loops ADD COLUMN pack_id TEXT"
        )
        self._add_column(
            "interview_loops",
            "focus_skills",
            "ALTER TABLE interview_loops ADD COLUMN focus_skills TEXT NOT NULL DEFAULT '[]'",
        )
        self._add_column(
            "preparation_actions",
            "resources",
            "ALTER TABLE preparation_actions ADD COLUMN resources TEXT NOT NULL DEFAULT '[]'",
        )
        self._add_column(
            "candidate_answers", "voice", "ALTER TABLE candidate_answers ADD COLUMN voice TEXT"
        )
        self._add_column(
            "interview_sessions",
            "context_id",
            "ALTER TABLE interview_sessions ADD COLUMN context_id TEXT",
        )
        self._add_column(
            "interview_sessions",
            "focus_skills",
            "ALTER TABLE interview_sessions ADD COLUMN focus_skills TEXT NOT NULL DEFAULT '[]'",
        )
        self._add_column(
            "candidate_answers",
            "plugin_reviews",
            "ALTER TABLE candidate_answers ADD COLUMN plugin_reviews TEXT",
        )
        self._add_column(
            "candidate_answers", "fields", "ALTER TABLE candidate_answers ADD COLUMN fields TEXT"
        )
        self._add_column(
            "preparation_actions",
            "source",
            "ALTER TABLE preparation_actions ADD COLUMN source TEXT NOT NULL DEFAULT 'planner'",
        )
        self._add_column(
            "interview_sessions",
            "plugin_mode_id",
            "ALTER TABLE interview_sessions ADD COLUMN plugin_mode_id TEXT",
        )
        self._add_column("ai_usage", "model", "ALTER TABLE ai_usage ADD COLUMN model TEXT")
        self._add_column("ai_usage", "attempt", "ALTER TABLE ai_usage ADD COLUMN attempt INTEGER")
        self._add_column("ai_usage", "ok", "ALTER TABLE ai_usage ADD COLUMN ok INTEGER")
        self._add_column(
            "ai_usage", "error_code", "ALTER TABLE ai_usage ADD COLUMN error_code TEXT"
        )
        # backfill: existing actions belong to whichever target was active at upgrade time
        self._exec(
            "UPDATE preparation_actions SET target_id = ("
            " SELECT id FROM target_roles WHERE active = 1 LIMIT 1"
            ") WHERE target_id IS NULL"
        )
        # settings: copy legacy codexModel → model when model is absent (the old
        # key stays, so the migration is idempotent and reversible).
        self._exec(
            "INSERT INTO settings (key, value)"
            " SELECT 'model', value FROM settings"
            " WHERE key = 'codexModel'"
            "   AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'model')"
        )

    def _add_column(self, table: str, column: str, ddl: str) -> None:
        columns = self._query(f'PRAGMA table_info("{table}")')
        if not any(str(row["name"]) == column for row in columns):
            self._exec(ddl)

    # ------------------------------------------------------------ primitives

    def _exec(self, statement: str) -> None:
        conn = self._conn if self._conn is not None else self._tx.connection
        if conn is not None:
            conn.exec_driver_sql(statement)
            return
        with self._engine.connect() as conn:
            conn.exec_driver_sql(statement)
            conn.commit()

    def _query(self, statement: str, params: Mapping[str, Any] | None = None) -> list[Any]:
        with self._read_conn() as conn:
            return list(conn.execute(text(statement), dict(params or {})).mappings())

    @contextmanager
    def _read_conn(self) -> Iterator[Any]:
        """The connection every statement must go through.

        The database has a single connection; inside a transaction it is the
        transaction connection, so reads see that snapshot and writes join it.
        """

        if self._conn is not None:
            yield self._conn
            return
        if self._tx.connection is not None:
            yield self._tx.connection
            return
        with self._engine.connect() as conn:
            yield conn

    def _one(self, table: str, where: Mapping[str, Any]) -> dict[str, Any] | None:
        self._check_table(table)
        with self._read_conn() as conn:
            row = (
                conn.execute(select(Base.metadata.tables[table]).filter_by(**dict(where)))
                .mappings()
                .first()
            )
        return None if row is None else dict(row)

    def _many(self, table: str, order_by: str | None = None) -> list[dict[str, Any]]:
        self._check_table(table)
        table_obj = Base.metadata.tables[table]
        stmt = select(table_obj)
        if order_by is not None:
            stmt = stmt.order_by(table_obj.c[order_by])
        with self._read_conn() as conn:
            return [dict(row) for row in conn.execute(stmt).mappings()]

    def _write(self, stmt: Any) -> None:
        conn = self._conn if self._conn is not None else self._tx.connection
        if conn is not None:
            conn.execute(stmt)
            return
        with self._engine.begin() as conn:
            conn.execute(stmt)

    def _check_table(self, table: str) -> None:
        if table not in TABLE_NAMES:
            raise StoreDataError(table, "table", f"unknown table (expected one of {TABLE_NAMES})")

    def _primary_key(self, table: str) -> list[str]:
        self._check_table(table)
        return [column.name for column in Base.metadata.tables[table].primary_key.columns]

    def _insert(self, table: str, values: Mapping[str, Any]) -> None:
        self._check_table(table)
        self._write(insert(Base.metadata.tables[table]).values(**dict(values)))

    def _update(self, table: str, where: Mapping[str, Any], patch: Mapping[str, Any]) -> None:
        self._check_table(table)
        self._write(
            update(Base.metadata.tables[table]).filter_by(**dict(where)).values(**dict(patch))
        )

    def _upsert(self, table: str, keys: Mapping[str, Any], values: Mapping[str, Any]) -> None:
        if self._one(table, keys) is None:
            self._insert(table, {**keys, **values})
        else:
            self._update(table, keys, values)

    # ------------------------------------------------------ settings (k/v)

    def get_setting(self, key: str) -> str | None:
        row = self._one("settings", {"key": key})
        return None if row is None else str(row["value"])

    def set_setting(self, key: str, value: str | None) -> None:
        if value is None:
            self._write(
                delete(Base.metadata.tables["settings"]).where(
                    Base.metadata.tables["settings"].c.key == key
                )
            )
            return
        self._upsert("settings", {"key": key}, {"value": value})

    def all_settings(self) -> dict[str, str]:
        return {str(row["key"]): str(row["value"]) for row in self._many("settings")}

    # ------------------------------------------------- candidates / targets

    def insert_candidate(
        self,
        *,
        id: str,
        active: int,
        name: str | None,
        headline: str | None,
        resume_text: str,
        data: CandidateProfile,
        created_at: str,
    ) -> None:
        self._insert(
            "candidate_profiles",
            {
                "id": id,
                "active": active,
                "name": name,
                "headline": headline,
                "resume_text": resume_text,
                "data": _dump(data),
                "created_at": created_at,
            },
        )

    def deactivate_candidates(self) -> None:
        self._write(update(Base.metadata.tables["candidate_profiles"]).values(active=0))

    def list_candidates(self) -> list[CandidateRow]:
        return [_candidate(row) for row in self._many("candidate_profiles")]

    def get_active_candidate(self) -> CandidateRow | None:
        row = self._one("candidate_profiles", {"active": 1})
        return None if row is None else _candidate(row)

    def insert_target(
        self,
        *,
        id: str,
        active: int,
        company: str,
        role: str,
        level: str,
        job_description: str,
        data: TargetRole,
        created_at: str,
    ) -> None:
        self._insert(
            "target_roles",
            {
                "id": id,
                "active": active,
                "company": company,
                "role": role,
                "level": level,
                "job_description": job_description,
                "data": _dump(data),
                "created_at": created_at,
            },
        )

    def deactivate_targets(self) -> None:
        self._write(update(Base.metadata.tables["target_roles"]).values(active=0))

    def get_active_target(self) -> TargetRow | None:
        row = self._one("target_roles", {"active": 1})
        return None if row is None else _target(row)

    def list_targets(self) -> list[TargetRow]:
        return [
            _target(row)
            for row in self._query("SELECT * FROM target_roles ORDER BY created_at DESC")
        ]

    def get_target(self, id: str) -> TargetRow | None:
        row = self._one("target_roles", {"id": id})
        return None if row is None else _target(row)

    def activate_target(self, id: str) -> None:
        # Atomic deactivate-all + activate-one: a mid-sequence failure must never
        # leave the workspace with no active target.
        with self.transaction() as tx:
            tx.deactivate_targets()
            tx._update("target_roles", {"id": id}, {"active": 1})

    def update_target_data(self, id: str, data: TargetRole) -> None:
        self._update("target_roles", {"id": id}, {"data": _dump(data)})

    # ------------------------------------------------------------- sessions

    def insert_session(
        self,
        *,
        id: str,
        created_at: str,
        candidate_id: str | None = None,
        target_id: str | None = None,
        status: str = "created",
        current_round: int = 0,
        planned_questions: int = 4,
        mode: str = "interview",
        round_type: str = "mixed",
        focus_skill_id: str | None = None,
        action_id: str | None = None,
        mode_state: ModeState | None = None,
        loop_id: str | None = None,
        loop_round: int | None = None,
        context_id: str | None = None,
        focus_skills: list[SkillId] | None = None,
        completed_at: str | None = None,
        plugin_mode_id: str | None = None,
    ) -> None:
        self._insert(
            "interview_sessions",
            {
                "id": id,
                "candidate_id": candidate_id,
                "target_id": target_id,
                "status": status,
                "current_round": current_round,
                "planned_questions": planned_questions,
                "mode": mode,
                "round_type": round_type,
                "focus_skill_id": focus_skill_id,
                "action_id": action_id,
                "mode_state": _dump(mode_state if mode_state is not None else {}),
                "loop_id": loop_id,
                "loop_round": loop_round,
                "context_id": context_id,
                "focus_skills": _dump(focus_skills if focus_skills is not None else []),
                "created_at": created_at,
                "completed_at": completed_at,
                "plugin_mode_id": plugin_mode_id,
            },
        )

    def get_session(self, id: str) -> SessionRow | None:
        row = self._one("interview_sessions", {"id": id})
        return None if row is None else _session(row)

    def update_session(self, id: str, patch: Mapping[str, Any]) -> None:
        """Patch session columns by database column name (snake_case)."""

        self._update("interview_sessions", {"id": id}, patch)

    def list_sessions(self) -> list[SessionRow]:
        return [
            _session(row)
            for row in self._query("SELECT * FROM interview_sessions ORDER BY created_at DESC")
        ]

    # -------------------------------------------------- questions / answers

    def insert_question(
        self,
        *,
        id: str,
        session_id: str,
        skill_id: str,
        text: str,
        created_at: str,
        topic: str = "",
        sub_skills: list[SkillId] | None = None,
        expected_concepts: list[ExpectedConcept] | None = None,
        difficulty: str = "medium",
        selection_priority: float | None = None,
        selection_reason: str | None = None,
        selection_factors: Mapping[str, Any] | None = None,
        follow_up_of: str | None = None,
        follow_up_focus: str | None = None,
        extra: Mapping[str, Any] | None = None,
        position: int = 0,
    ) -> None:
        self._insert(
            "interview_questions",
            {
                "id": id,
                "session_id": session_id,
                "skill_id": skill_id,
                "topic": topic,
                "text": text,
                "sub_skills": _dump(sub_skills if sub_skills is not None else []),
                "expected_concepts": _dump(
                    expected_concepts if expected_concepts is not None else []
                ),
                "difficulty": difficulty,
                "selection_priority": selection_priority,
                "selection_reason": selection_reason,
                "selection_factors": _dump(dict(selection_factors or {})),
                "follow_up_of": follow_up_of,
                "follow_up_focus": follow_up_focus,
                "extra": _dump(dict(extra or {})),
                "position": position,
                "created_at": created_at,
            },
        )

    def list_questions(self, session_id: str) -> list[QuestionRow]:
        rows = self._query(
            "SELECT * FROM interview_questions WHERE session_id = :session_id ORDER BY position",
            {"session_id": session_id},
        )
        return [_question(row) for row in rows]

    def get_question(self, id: str) -> QuestionRow | None:
        row = self._one("interview_questions", {"id": id})
        return None if row is None else _question(row)

    def insert_answer(
        self,
        *,
        id: str,
        question_id: str,
        session_id: str,
        text: str,
        created_at: str,
        code: str | None = None,
        language: str | None = None,
        status: str = "evaluated",
        voice: AnswerVoice | None = None,
        plugin_reviews: list[AnswerPluginReview] | None = None,
        fields: Mapping[str, JsonScalar] | None = None,
    ) -> None:
        self._insert(
            "candidate_answers",
            {
                "id": id,
                "question_id": question_id,
                "session_id": session_id,
                "text": text,
                "code": code,
                "language": language,
                "status": status,
                "created_at": created_at,
                "voice": None if voice is None else _dump(voice),
                "plugin_reviews": None if plugin_reviews is None else _dump(plugin_reviews),
                "fields": None if fields is None else _dump(dict(fields)),
            },
        )

    def list_answers(self, session_id: str) -> list[AnswerRow]:
        rows = self._query(
            "SELECT * FROM candidate_answers WHERE session_id = :session_id",
            {"session_id": session_id},
        )
        return [_answer(row) for row in rows]

    def get_answer_for_question(self, question_id: str) -> AnswerRow | None:
        row = self._one("candidate_answers", {"question_id": question_id})
        return None if row is None else _answer(row)

    def get_evaluated_answer_for_question(self, question_id: str) -> AnswerRow | None:
        row = self._one("candidate_answers", {"question_id": question_id, "status": "evaluated"})
        return None if row is None else _answer(row)

    def update_answer_status(self, id: str, status: str) -> None:
        self._update("candidate_answers", {"id": id}, {"status": status})

    def update_answer_plugin_reviews(self, id: str, reviews: list[AnswerPluginReview]) -> None:
        self._update("candidate_answers", {"id": id}, {"plugin_reviews": _dump(reviews)})

    # ---------------------------------------------------------- evaluations

    def insert_evaluation(
        self,
        *,
        id: str,
        answer_id: str,
        question_id: str,
        session_id: str,
        data: AnswerEvaluation,
        created_at: str,
        readiness_delta: list[ReadinessDeltaEntry] | None = None,
    ) -> None:
        self._insert(
            "answer_evaluations",
            {
                "id": id,
                "answer_id": answer_id,
                "question_id": question_id,
                "session_id": session_id,
                "data": _dump(data),
                "readiness_delta": _dump(readiness_delta if readiness_delta is not None else []),
                "created_at": created_at,
            },
        )

    def update_evaluation_delta(self, id: str, delta: list[ReadinessDeltaEntry]) -> None:
        self._update("answer_evaluations", {"id": id}, {"readiness_delta": _dump(delta)})

    def list_evaluations(self, session_id: str) -> list[EvaluationRow]:
        rows = self._query(
            "SELECT * FROM answer_evaluations WHERE session_id = :session_id",
            {"session_id": session_id},
        )
        return [_evaluation(row) for row in rows]

    def list_all_evaluations(self) -> list[EvaluationRow]:
        return [_evaluation(row) for row in self._many("answer_evaluations")]

    # ------------------------------------------------------------- evidence

    def insert_evidence(
        self,
        *,
        id: str,
        skill_id: str,
        type: str,
        score: float,
        confidence: float,
        created_at: str,
        candidate_id: str | None = None,
        observation: str = "",
        session_id: str | None = None,
        question_id: str | None = None,
        source: str | None = None,
    ) -> None:
        self._insert(
            "skill_evidence",
            {
                "id": id,
                "candidate_id": candidate_id,
                "skill_id": skill_id,
                "type": type,
                "score": score,
                "confidence": confidence,
                "observation": observation,
                "session_id": session_id,
                "question_id": question_id,
                "source": source,
                "created_at": created_at,
            },
        )

    def list_evidence(self, candidate_id: str | None = None) -> list[EvidenceRow]:
        if candidate_id is None:
            rows = self._many("skill_evidence")
        else:
            rows = self._query(
                "SELECT * FROM skill_evidence WHERE candidate_id = :candidate_id",
                {"candidate_id": candidate_id},
            )
        return [_evidence(row) for row in rows]

    def evidence_for_skill(
        self, skill_id: str, candidate_id: str | None = None
    ) -> list[EvidenceRow]:
        if candidate_id is None:
            rows = self._query(
                "SELECT * FROM skill_evidence WHERE skill_id = :skill_id", {"skill_id": skill_id}
            )
        else:
            rows = self._query(
                "SELECT * FROM skill_evidence WHERE skill_id = :skill_id"
                " AND candidate_id = :candidate_id",
                {"skill_id": skill_id, "candidate_id": candidate_id},
            )
        return [_evidence(row) for row in rows]

    # -------------------------------------------------- readiness snapshots

    def append_readiness_snapshot(
        self,
        *,
        skill_id: str,
        score: float | None,
        confidence: float,
        evidence_ids: list[str],
        reason: str,
        computed_at: str,
    ) -> None:
        """Append-only: snapshots are never updated or overwritten (§9.7)."""

        self._insert(
            "readiness_scores",
            {
                "skill_id": skill_id,
                "score": score,
                "confidence": confidence,
                "evidence_ids": _dump(evidence_ids),
                "reason": reason,
                "computed_at": computed_at,
            },
        )

    def latest_readiness_by_skill(self) -> dict[str, ReadinessRow]:
        rows = self._query("SELECT * FROM readiness_scores ORDER BY id DESC")
        latest: dict[str, ReadinessRow] = {}
        for row in rows:
            parsed = _readiness(row)
            if parsed.skill_id not in latest:
                latest[parsed.skill_id] = parsed
        return latest

    def readiness_history(self, skill_id: str) -> list[ReadinessRow]:
        rows = self._query(
            "SELECT * FROM readiness_scores WHERE skill_id = :skill_id ORDER BY id DESC",
            {"skill_id": skill_id},
        )
        return [_readiness(row) for row in rows]

    def list_all_readiness(self) -> list[ReadinessRow]:
        return [
            _readiness(row) for row in self._query("SELECT * FROM readiness_scores ORDER BY id")
        ]

    def count_readiness_snapshots(self) -> int:
        rows = self._query("SELECT count(*) AS n FROM readiness_scores")
        return int(rows[0]["n"])

    # --------------------------------------------------------- prep actions

    def insert_action(
        self,
        *,
        id: str,
        skill_id: str,
        priority: float,
        action: str,
        created_at: str,
        target_id: str | None = None,
        reason: str = "",
        success_criteria: list[str] | None = None,
        status: str = "open",
        severity: str = "medium",
        source_evidence_ids: list[str] | None = None,
        resources: list[PrepResource] | None = None,
        source: str = "planner",
    ) -> None:
        self._insert(
            "preparation_actions",
            {
                "id": id,
                "skill_id": skill_id,
                "target_id": target_id,
                "priority": priority,
                "reason": reason,
                "action": action,
                "success_criteria": _dump(success_criteria if success_criteria is not None else []),
                "status": status,
                "severity": severity,
                "created_at": created_at,
                "source_evidence_ids": _dump(
                    source_evidence_ids if source_evidence_ids is not None else []
                ),
                "resources": _dump(resources if resources is not None else []),
                "source": source,
            },
        )

    def update_action_status(self, id: str, status: str) -> None:
        self._update("preparation_actions", {"id": id}, {"status": status})

    def get_action(self, id: str) -> PrepActionRow | None:
        row = self._one("preparation_actions", {"id": id})
        return None if row is None else _action(row)

    def update_action_priority(self, id: str, priority: float) -> None:
        self._update("preparation_actions", {"id": id}, {"priority": priority})

    def update_action_source_evidence(self, id: str, source_evidence_ids: list[str]) -> None:
        self._update(
            "preparation_actions", {"id": id}, {"source_evidence_ids": _dump(source_evidence_ids)}
        )

    def update_action_resources(self, id: str, resources: list[PrepResource]) -> None:
        self._update("preparation_actions", {"id": id}, {"resources": _dump(resources)})

    def list_actions(
        self, status: str | None = None, target_id: str | None = None
    ) -> list[PrepActionRow]:
        clauses: list[str] = []
        params: dict[str, Any] = {}
        if status is not None:
            clauses.append("status = :status")
            params["status"] = status
        if target_id is not None:
            clauses.append("target_id = :target_id")
            params["target_id"] = target_id
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._query(f"SELECT * FROM preparation_actions{where}", params)
        actions = [_action(row) for row in rows]
        return sorted(actions, key=lambda action: action.priority)

    def open_action_for_skill(
        self, skill_id: str, target_id: str | None = None
    ) -> PrepActionRow | None:
        where: dict[str, Any] = {"skill_id": skill_id, "status": "open"}
        if target_id is not None:
            where["target_id"] = target_id
        row = self._one("preparation_actions", where)
        return None if row is None else _action(row)

    def actions_for_skill(self, skill_id: str, target_id: str | None = None) -> list[PrepActionRow]:
        where: dict[str, Any] = {"skill_id": skill_id}
        if target_id is not None:
            where["target_id"] = target_id
        return [_action(row) for row in self._many_where("preparation_actions", where)]

    # ------------------------------------------------------- loops (§9.4)

    def insert_loop(
        self,
        *,
        id: str,
        created_at: str,
        target_id: str | None = None,
        company_profile_id: str = "generic",
        rounds: list[Any] | None = None,
        status: str = "planned",
        pack_id: str | None = None,
        focus_skills: list[SkillId] | None = None,
        current_round: int = 0,
        abandoned: int = 0,
        debrief: Any = None,
        completed_at: str | None = None,
    ) -> None:
        self._insert(
            "interview_loops",
            {
                "id": id,
                "target_id": target_id,
                "company_profile_id": company_profile_id,
                "rounds": _dump(rounds if rounds is not None else []),
                "status": status,
                "pack_id": pack_id,
                "focus_skills": _dump(focus_skills if focus_skills is not None else []),
                "current_round": current_round,
                "abandoned": abandoned,
                "debrief": None if debrief is None else _dump(debrief),
                "created_at": created_at,
                "completed_at": completed_at,
            },
        )

    def get_loop(self, id: str) -> InterviewLoopRow | None:
        row = self._one("interview_loops", {"id": id})
        return None if row is None else _loop(row)

    def list_loops(self) -> list[InterviewLoopRow]:
        return [
            _loop(row)
            for row in self._query("SELECT * FROM interview_loops ORDER BY created_at DESC")
        ]

    def update_loop(self, id: str, patch: Mapping[str, Any]) -> None:
        self._update("interview_loops", {"id": id}, patch)

    def loop_for_session(self, session_id: str) -> InterviewLoopRow | None:
        session = self.get_session(session_id)
        return (
            None if session is None or session.loop_id is None else self.get_loop(session.loop_id)
        )

    # ----------------------------------------------------------- debriefs

    def insert_debrief(self, *, id: str, session_id: str, data: Any, created_at: str) -> None:
        self._insert(
            "interview_debriefs",
            {
                "id": id,
                "session_id": session_id,
                "data": _dump(data),
                "created_at": created_at,
            },
        )

    def get_debrief(self, session_id: str) -> InterviewDebriefRow | None:
        rows = self._query(
            "SELECT * FROM interview_debriefs WHERE session_id = :session_id"
            " ORDER BY created_at DESC",
            {"session_id": session_id},
        )
        return None if not rows else _debrief(rows[0])

    def list_all_debriefs(self) -> list[InterviewDebriefRow]:
        return [_debrief(row) for row in self._many("interview_debriefs")]

    # ------------------------------------------------- runtime sessions (§9.1)

    def insert_runtime_session(
        self,
        *,
        id: str,
        session_id: str,
        runtime: str,
        runtime_session_id: str,
        thread_id: str,
        created_at: str,
        status: str = "open",
    ) -> None:
        self._insert(
            "runtime_sessions",
            {
                "id": id,
                "session_id": session_id,
                "runtime": runtime,
                "runtime_session_id": runtime_session_id,
                "thread_id": thread_id,
                "status": status,
                "created_at": created_at,
            },
        )

    def get_runtime_session(self, session_id: str) -> RuntimeSessionRow | None:
        rows = self._query(
            "SELECT * FROM runtime_sessions WHERE session_id = :session_id"
            " ORDER BY created_at DESC",
            {"session_id": session_id},
        )
        return None if not rows else _runtime_session(rows[0])

    def update_runtime_session_status(self, id: str, status: str) -> None:
        self._update("runtime_sessions", {"id": id}, {"status": status})

    def find_runtime_session_by_thread(self, thread_id: str) -> RuntimeSessionRow | None:
        rows = self._query(
            "SELECT * FROM runtime_sessions WHERE thread_id = :thread_id"
            " ORDER BY created_at DESC",
            {"thread_id": thread_id},
        )
        return None if not rows else _runtime_session(rows[0])

    def reset_all(self) -> None:
        """Test-mode only: wipe persisted state (excludes MCP/plugin config tables)."""

        tables = (
            "candidate_profiles",
            "target_roles",
            "interview_sessions",
            "interview_loops",
            "interview_questions",
            "candidate_answers",
            "answer_evaluations",
            "skill_nodes",
            "skill_evidence",
            "readiness_scores",
            "preparation_actions",
            "runtime_sessions",
            "interview_debriefs",
            "star_stories",
            "settings",
            "resume_reviews",
            "usage_events",
            "ai_usage",
            "interview_packs",
            "user_questions",
            "plugin_installs",
        )
        with self.transaction() as tx:
            for table in tables:
                tx._exec(f'DELETE FROM "{table}"')

    # ------------------------------------------------- star stories (§8.4)

    def insert_story(
        self,
        *,
        id: str,
        candidate_id: str,
        title: str,
        updated_at: str,
        situation: str = "",
        task: str = "",
        action: str = "",
        result: str = "",
        skill_ids: list[SkillId] | None = None,
        source: str = "user",
    ) -> None:
        self._insert(
            "star_stories",
            {
                "id": id,
                "candidate_id": candidate_id,
                "title": title,
                "situation": situation,
                "task": task,
                "action": action,
                "result": result,
                "skill_ids": _dump(skill_ids if skill_ids is not None else []),
                "source": source,
                "updated_at": updated_at,
            },
        )

    def list_stories(self, candidate_id: str) -> list[StarStoryRow]:
        rows = self._query(
            "SELECT * FROM star_stories WHERE candidate_id = :candidate_id"
            " ORDER BY updated_at DESC",
            {"candidate_id": candidate_id},
        )
        return [_story(row) for row in rows]

    def list_all_stories(self) -> list[StarStoryRow]:
        return [_story(row) for row in self._many("star_stories")]

    def get_story(self, id: str) -> StarStoryRow | None:
        row = self._one("star_stories", {"id": id})
        return None if row is None else _story(row)

    def update_story(self, id: str, patch: Mapping[str, Any]) -> None:
        self._update("star_stories", {"id": id}, patch)

    # ---------------------------------------------- resume reviews (§9.5)

    def insert_resume_review(
        self,
        *,
        id: str,
        created_at: str,
        candidate_id: str | None = None,
        target_id: str | None = None,
        ats: Any = None,
        suggestions: Any = None,
        tailoring: Any = None,
        linked_gap_skill_ids: list[str] | None = None,
        guard: Any = None,
    ) -> None:
        self._insert(
            "resume_reviews",
            {
                "id": id,
                "candidate_id": candidate_id,
                "target_id": target_id,
                "ats": _dump(ats if ats is not None else {}),
                "suggestions": _dump(suggestions if suggestions is not None else []),
                "tailoring": None if tailoring is None else _dump(tailoring),
                "linked_gap_skill_ids": _dump(
                    linked_gap_skill_ids if linked_gap_skill_ids is not None else []
                ),
                "guard": _dump(guard if guard is not None else {}),
                "created_at": created_at,
            },
        )

    def list_all_resume_reviews(self) -> list[ResumeReviewRow]:
        return [_resume_review(row) for row in self._many("resume_reviews")]

    def latest_resume_review(self, candidate_id: str | None = None) -> ResumeReviewRow | None:
        rows = [
            _resume_review(row)
            for row in self._query("SELECT * FROM resume_reviews ORDER BY created_at DESC")
        ]
        if not rows:
            return None
        if candidate_id is not None:
            return next((row for row in rows if row.candidate_id == candidate_id), rows[0])
        return rows[0]

    # ------------------------------------------ interview packs (v0.4)

    def insert_interview_pack(
        self, *, id: str, data: Any, source: str, created_at: str, updated_at: str
    ) -> None:
        self._insert(
            "interview_packs",
            {
                "id": id,
                "data": _dump(data),
                "source": source,
                "created_at": created_at,
                "updated_at": updated_at,
            },
        )

    def upsert_interview_pack(
        self, *, id: str, data: Any, source: str, created_at: str, updated_at: str
    ) -> None:
        values = {
            "data": _dump(data),
            "source": source,
            "created_at": created_at,
            "updated_at": updated_at,
        }
        if self._one("interview_packs", {"id": id}) is None:
            self._insert("interview_packs", {"id": id, **values})
        else:
            self._update("interview_packs", {"id": id}, values)

    def get_interview_pack(self, id: str) -> InterviewPackRow | None:
        row = self._one("interview_packs", {"id": id})
        return None if row is None else _interview_pack(row)

    def list_interview_packs(self) -> list[InterviewPackRow]:
        return [
            _interview_pack(row)
            for row in self._query("SELECT * FROM interview_packs ORDER BY created_at DESC")
        ]

    def delete_interview_pack(self, id: str) -> None:
        self._write(
            delete(Base.metadata.tables["interview_packs"]).where(
                Base.metadata.tables["interview_packs"].c.id == id
            )
        )

    # --------------------------------------- user question bank (v0.4)

    def insert_user_question(
        self,
        *,
        id: str,
        skill_id: str,
        text: str,
        created_at: str,
        difficulty: str | None = None,
        mode: str | None = None,
    ) -> None:
        self._insert(
            "user_questions",
            {
                "id": id,
                "skill_id": skill_id,
                "text": text,
                "difficulty": difficulty,
                "mode": mode,
                "created_at": created_at,
            },
        )

    def get_user_question(self, id: str) -> UserQuestionRow | None:
        row = self._one("user_questions", {"id": id})
        return None if row is None else _user_question(row)

    def list_user_questions(self) -> list[UserQuestionRow]:
        return [
            _user_question(row)
            for row in self._query("SELECT * FROM user_questions ORDER BY created_at")
        ]

    def delete_user_question(self, id: str) -> None:
        self._write(
            delete(Base.metadata.tables["user_questions"]).where(
                Base.metadata.tables["user_questions"].c.id == id
            )
        )

    # --------------------------- usage events (§9.7: names only)

    def insert_usage_event(self, *, id: str, event: str, created_at: str) -> None:
        self._insert("usage_events", {"id": id, "event": event, "created_at": created_at})

    def count_usage_events(self, event: str | None = None) -> int:
        if event is None:
            rows = self._query("SELECT count(*) AS n FROM usage_events")
        else:
            rows = self._query(
                "SELECT count(*) AS n FROM usage_events WHERE event = :event", {"event": event}
            )
        return int(rows[0]["n"])

    # -------------------- AI usage telemetry (append-only; distinct from usage_events)

    def insert_ai_usage(self, row: AIUsageRow) -> None:
        self._insert(
            "ai_usage",
            {
                "id": row.id,
                "runtime_kind": row.runtime_kind,
                "provider_session_id": row.provider_session_id,
                "interview_session_id": row.interview_session_id,
                "task_id": row.task_id,
                "model": row.model,
                "attempt": row.attempt,
                "ok": row.ok,
                "error_code": row.error_code,
                "input_tokens": row.input_tokens,
                "output_tokens": row.output_tokens,
                "thought_tokens": row.thought_tokens,
                "cached_read_tokens": row.cached_read_tokens,
                "cached_write_tokens": row.cached_write_tokens,
                "total_tokens": row.total_tokens,
                "context_used": row.context_used,
                "context_size": row.context_size,
                "cost_amount": row.cost_amount,
                "cost_currency": row.cost_currency,
                "stop_reason": row.stop_reason,
                "duration_ms": row.duration_ms,
                "created_at": row.created_at,
            },
        )

    #: Whitelisted breakdown columns (never interpolate user input into SQL).
    _AI_USAGE_GROUPS: dict[str, str] = {
        "runtime": "runtime_kind",
        "skill": "task_id",
        "model": "model",
    }

    def _ai_usage_clauses(
        self,
        *,
        since: str | None,
        until: str | None,
        runtime: str | None,
        session: str | None,
    ) -> tuple[list[str], dict[str, Any]]:
        clauses: list[str] = []
        params: dict[str, Any] = {}
        if since is not None:
            clauses.append("created_at >= :since")
            params["since"] = since
        if until is not None:
            clauses.append("created_at <= :until")
            params["until"] = until
        if runtime is not None:
            clauses.append("runtime_kind = :runtime")
            params["runtime"] = runtime
        if session is not None:
            clauses.append("interview_session_id = :session")
            params["session"] = session
        return clauses, params

    @staticmethod
    def _ai_usage_where(clauses: list[str]) -> str:
        return f" WHERE {' AND '.join(clauses)}" if clauses else ""

    def list_ai_usage(
        self,
        *,
        since: str | None = None,
        until: str | None = None,
        runtime: str | None = None,
        session: str | None = None,
        limit: int | None = None,
    ) -> list[AIUsageRow]:
        clauses, params = self._ai_usage_clauses(
            since=since, until=until, runtime=runtime, session=session
        )
        sql = f"SELECT * FROM ai_usage{self._ai_usage_where(clauses)} ORDER BY created_at DESC"
        if limit is not None:
            sql += " LIMIT :limit"
            params["limit"] = int(limit)
        return [_ai_usage(row) for row in self._query(sql, params)]

    def ai_usage_totals(
        self,
        *,
        since: str | None = None,
        until: str | None = None,
        runtime: str | None = None,
        session: str | None = None,
    ) -> dict[str, Any]:
        clauses, params = self._ai_usage_clauses(
            since=since, until=until, runtime=runtime, session=session
        )
        rows = self._query(
            "SELECT COUNT(*) AS turns,"
            " COALESCE(SUM(input_tokens), 0) AS input_tokens,"
            " COALESCE(SUM(output_tokens), 0) AS output_tokens,"
            " COALESCE(SUM(thought_tokens), 0) AS thought_tokens,"
            " COALESCE(SUM(cached_read_tokens), 0) AS cached_read_tokens,"
            " COALESCE(SUM(cached_write_tokens), 0) AS cached_write_tokens,"
            " COALESCE(SUM(total_tokens), 0) AS total_tokens,"
            " SUM(CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL"
            " OR thought_tokens IS NOT NULL OR cached_read_tokens IS NOT NULL"
            " OR cached_write_tokens IS NOT NULL OR total_tokens IS NOT NULL"
            " THEN 1 ELSE 0 END) AS tokens_reported"
            f" FROM ai_usage{self._ai_usage_where(clauses)}",
            params,
        )
        return {} if not rows else dict(rows[0])

    def ai_usage_costs(
        self,
        *,
        since: str | None = None,
        until: str | None = None,
        runtime: str | None = None,
        session: str | None = None,
        group: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses, params = self._ai_usage_clauses(
            since=since, until=until, runtime=runtime, session=session
        )
        clauses += ["cost_amount IS NOT NULL", "cost_currency IS NOT NULL"]
        if group is not None:
            column = self._AI_USAGE_GROUPS[group]
            select = f"{column} AS group_key, "
            group_by = f" GROUP BY {column}, cost_currency"
            order = " ORDER BY group_key, currency"
        else:
            select = ""
            group_by = " GROUP BY cost_currency"
            order = " ORDER BY currency"
        rows = self._query(
            f"SELECT {select}cost_currency AS currency, SUM(cost_amount) AS amount"
            f" FROM ai_usage{self._ai_usage_where(clauses)}{group_by}{order}",
            params,
        )
        return [dict(row) for row in rows]

    def ai_usage_groups(
        self,
        group: str,
        *,
        since: str | None = None,
        until: str | None = None,
        runtime: str | None = None,
        session: str | None = None,
    ) -> list[dict[str, Any]]:
        column = self._AI_USAGE_GROUPS[group]
        clauses, params = self._ai_usage_clauses(
            since=since, until=until, runtime=runtime, session=session
        )
        rows = self._query(
            f"SELECT {column} AS group_key, COUNT(*) AS turns,"
            " COALESCE(SUM(input_tokens), 0) AS input_tokens,"
            " COALESCE(SUM(output_tokens), 0) AS output_tokens,"
            " COALESCE(SUM(total_tokens), 0) AS total_tokens"
            f" FROM ai_usage{self._ai_usage_where(clauses)}"
            f" GROUP BY {column} ORDER BY turns DESC, group_key",
            params,
        )
        return [dict(row) for row in rows]

    def ai_usage_latest_context(
        self,
        *,
        since: str | None = None,
        until: str | None = None,
        runtime: str | None = None,
        session: str | None = None,
    ) -> dict[str, Any] | None:
        clauses, params = self._ai_usage_clauses(
            since=since, until=until, runtime=runtime, session=session
        )
        clauses += ["context_used IS NOT NULL", "context_size IS NOT NULL"]
        rows = self._query(
            "SELECT runtime_kind, provider_session_id, context_used AS used,"
            " context_size AS size, created_at"
            f" FROM ai_usage{self._ai_usage_where(clauses)}"
            " ORDER BY (interview_session_id IS NULL) ASC, created_at DESC LIMIT 1",
            params,
        )
        return None if not rows else dict(rows[0])

    def clear_ai_usage(self) -> int:
        """Delete every AI usage row — an explicit user action; returns the count.

        Deliberately bypasses the append-only guard (`delete_row`): clearing is a
        user-initiated reset, not a rewrite of recorded history.
        """

        rows = self._query("SELECT COUNT(*) AS n FROM ai_usage")
        self._write(delete(Base.metadata.tables["ai_usage"]))
        return int(rows[0]["n"])

    # ------------------------------------------- MCP server state (v0.4)

    def get_mcp_server(self, id: str) -> McpServerRow | None:
        row = self._one("mcp_servers", {"id": id})
        return None if row is None else _mcp_server(row)

    def upsert_mcp_server(
        self, *, id: str, enabled: int, allowed_tools: list[str], updated_at: str
    ) -> None:
        values = {
            "enabled": enabled,
            "allowed_tools": _dump(allowed_tools),
            "updated_at": updated_at,
        }
        if self._one("mcp_servers", {"id": id}) is None:
            self._insert("mcp_servers", {"id": id, **values})
        else:
            self._update("mcp_servers", {"id": id}, values)

    def list_mcp_servers(self) -> list[McpServerRow]:
        return [_mcp_server(row) for row in self._many("mcp_servers")]

    # --------------------------------------- external contexts (v0.4)

    def insert_external_context(self, row: ExternalContextRow) -> None:
        self._insert(
            "external_contexts",
            {
                "id": row.id,
                "server_id": row.server_id,
                "tool": row.tool,
                "title": row.title,
                "text": row.text,
                "created_at": row.created_at,
            },
        )

    def get_external_context(self, id: str) -> ExternalContextRow | None:
        row = self._one("external_contexts", {"id": id})
        return None if row is None else _external_context(row)

    def list_external_contexts(self) -> list[ExternalContextRow]:
        return [
            _external_context(row)
            for row in self._query("SELECT * FROM external_contexts ORDER BY created_at DESC")
        ]

    def delete_external_context(self, id: str) -> None:
        self._write(
            delete(Base.metadata.tables["external_contexts"]).where(
                Base.metadata.tables["external_contexts"].c.id == id
            )
        )

    # --------------------------------------- plugin installs (v0.4)

    def upsert_plugin_install(self, row: PluginInstallRow) -> None:
        """Insert or replace a plugin install row by id (`upsertPluginInstall`)."""

        values = {
            "enabled": row.enabled,
            "granted_permissions": _dump(row.granted_permissions),
            "source": row.source,
            "source_url": row.source_url,
            "dir_name": row.dir_name,
            "installed_at": row.installed_at,
            "updated_at": row.updated_at,
        }
        if self._one("plugin_installs", {"id": row.id}) is None:
            self._insert("plugin_installs", {"id": row.id, **values})
        else:
            self._update("plugin_installs", {"id": row.id}, values)

    def get_plugin_install(self, id: str) -> PluginInstallRow | None:
        row = self._one("plugin_installs", {"id": id})
        return None if row is None else _plugin_install(row)

    def list_plugin_installs(self) -> list[PluginInstallRow]:
        return [_plugin_install(row) for row in self._many("plugin_installs")]

    def delete_plugin_install(self, id: str) -> None:
        """Drop the install row; plugin-owned settings + KV rows go with it."""

        with self.transaction() as tx:
            tx.delete_rows_where("plugin_installs", id=id)
            tx.delete_rows_where("plugin_storage", plugin_id=id)
            tx.delete_rows_where("plugin_settings", plugin_id=id)

    # --------------------------------- v1 plugin settings + KV storage

    def get_plugin_settings(self, plugin_id: str) -> dict[str, Any]:
        where = {"plugin_id": plugin_id}
        parsed = [_plugin_setting(row) for row in self._many_where("plugin_settings", where)]
        return {row.key: row.value for row in parsed}

    def set_plugin_setting(self, plugin_id: str, key: str, value: Any) -> None:
        keys = {"plugin_id": plugin_id, "key": key}
        if self._one("plugin_settings", keys) is None:
            self._insert("plugin_settings", {**keys, "value": _dump(value)})
        else:
            self._update("plugin_settings", keys, {"value": _dump(value)})

    def get_plugin_storage_value(self, plugin_id: str, key: str) -> Any:
        row = self._one("plugin_storage", {"plugin_id": plugin_id, "key": key})
        return None if row is None else _plugin_storage(row).value

    def set_plugin_storage_value(self, plugin_id: str, key: str, value: Any) -> None:
        keys = {"plugin_id": plugin_id, "key": key}
        if self._one("plugin_storage", keys) is None:
            self._insert("plugin_storage", {**keys, "value": _dump(value)})
        else:
            self._update("plugin_storage", keys, {"value": _dump(value)})

    def delete_plugin_storage_value(self, plugin_id: str, key: str) -> None:
        self.delete_rows_where("plugin_storage", plugin_id=plugin_id, key=key)

    def plugin_storage_bytes(self, plugin_id: str) -> int:
        """Total KV footprint: `len(key) + len(JSON.stringify(value))` per row."""

        total = 0
        for row in self._many_where("plugin_storage", {"plugin_id": plugin_id}):
            parsed = _plugin_storage(row)
            total += len(parsed.key) + len(_dump(parsed.value))
        return total

    # --------------------------------------------- export bundle reads

    def list_all_questions(self) -> list[QuestionRow]:
        return [_question(row) for row in self._many("interview_questions")]

    def list_all_answers(self) -> list[AnswerRow]:
        return [_answer(row) for row in self._many("candidate_answers")]

    # --------------------------------------------- export bundle writes

    def wipe_export_tables(self) -> None:
        """v0.4 import: wipe every table the export bundle covers (in one
        transaction with the inserts at the caller). Settings/plugin/MCP state
        are NOT domain data — allowlisted settings keys are upserted by the
        importer."""

        for table in (
            "candidate_profiles",
            "target_roles",
            "interview_sessions",
            "interview_loops",
            "interview_questions",
            "candidate_answers",
            "answer_evaluations",
            "interview_debriefs",
            "skill_evidence",
            "readiness_scores",
            "preparation_actions",
            "star_stories",
            "resume_reviews",
            "interview_packs",
            "user_questions",
            "external_contexts",
        ):
            self._write(delete(Base.metadata.tables[table]))

    def insert_candidate_row(self, row: CandidateProfileRow) -> None:
        self._insert(
            "candidate_profiles",
            {
                "id": row.id,
                "active": row.active,
                "name": row.name,
                "headline": row.headline,
                "resume_text": row.resume_text,
                "data": _dump(row.data),
                "created_at": row.created_at,
            },
        )

    def insert_target_row(self, row: TargetRoleRow) -> None:
        self._insert(
            "target_roles",
            {
                "id": row.id,
                "active": row.active,
                "company": row.company,
                "role": row.role,
                "level": row.level,
                "job_description": row.job_description,
                "data": _dump(row.data),
                "created_at": row.created_at,
            },
        )

    def insert_loop_row(self, row: InterviewLoopRow) -> None:
        self._insert(
            "interview_loops",
            {
                "id": row.id,
                "target_id": row.target_id,
                "company_profile_id": row.company_profile_id,
                "rounds": _dump(row.rounds),
                "status": row.status,
                "pack_id": row.pack_id,
                "focus_skills": _dump(row.focus_skills),
                "current_round": row.current_round,
                "abandoned": row.abandoned,
                "debrief": None if row.debrief is None else _dump(row.debrief),
                "created_at": row.created_at,
                "completed_at": row.completed_at,
            },
        )

    def insert_session_row(self, row: InterviewSessionRow) -> None:
        self._insert(
            "interview_sessions",
            {
                "id": row.id,
                "candidate_id": row.candidate_id,
                "target_id": row.target_id,
                "status": row.status,
                "current_round": row.current_round,
                "planned_questions": row.planned_questions,
                "mode": row.mode,
                "round_type": row.round_type,
                "focus_skill_id": row.focus_skill_id,
                "action_id": row.action_id,
                "mode_state": _dump(row.mode_state),
                "loop_id": row.loop_id,
                "loop_round": row.loop_round,
                "context_id": row.context_id,
                "created_at": row.created_at,
                "completed_at": row.completed_at,
            },
        )

    def insert_question_row(self, row: InterviewQuestionRow) -> None:
        self._insert(
            "interview_questions",
            {
                "id": row.id,
                "session_id": row.session_id,
                "skill_id": row.skill_id,
                "topic": row.topic,
                "text": row.text,
                "sub_skills": _dump(row.sub_skills),
                "expected_concepts": _dump(row.expected_concepts),
                "difficulty": row.difficulty,
                "selection_priority": row.selection_priority,
                "selection_reason": row.selection_reason,
                "selection_factors": _dump(row.selection_factors),
                "follow_up_of": row.follow_up_of,
                "follow_up_focus": row.follow_up_focus,
                "extra": _dump(row.extra),
                "position": row.position,
                "created_at": row.created_at,
            },
        )

    def insert_answer_row(self, row: CandidateAnswerRow) -> None:
        self._insert(
            "candidate_answers",
            {
                "id": row.id,
                "question_id": row.question_id,
                "session_id": row.session_id,
                "text": row.text,
                "code": row.code,
                "language": row.language,
                "voice": None if row.voice is None else _dump(row.voice),
                "status": row.status,
                "created_at": row.created_at,
            },
        )

    def insert_evaluation_row(self, row: AnswerEvaluationRow) -> None:
        self._insert(
            "answer_evaluations",
            {
                "id": row.id,
                "answer_id": row.answer_id,
                "question_id": row.question_id,
                "session_id": row.session_id,
                "data": _dump(row.data),
                "readiness_delta": _dump(row.readiness_delta),
                "created_at": row.created_at,
            },
        )

    def insert_debrief_row(self, row: InterviewDebriefRow) -> None:
        self._insert(
            "interview_debriefs",
            {
                "id": row.id,
                "session_id": row.session_id,
                "data": _dump(row.data),
                "created_at": row.created_at,
            },
        )

    def insert_evidence_row(self, row: SkillEvidenceRow) -> None:
        self._insert(
            "skill_evidence",
            {
                "id": row.id,
                "candidate_id": row.candidate_id,
                "skill_id": row.skill_id,
                "type": row.type,
                "score": row.score,
                "confidence": row.confidence,
                "observation": row.observation,
                "session_id": row.session_id,
                "question_id": row.question_id,
                "source": row.source,
                "created_at": row.created_at,
            },
        )

    def append_readiness_snapshot_row(self, row: ReadinessScoreRow) -> None:
        """Import path: the bundle carries the snapshot id, so it is preserved."""

        self._insert(
            "readiness_scores",
            {
                "id": row.id,
                "skill_id": row.skill_id,
                "score": row.score,
                "confidence": row.confidence,
                "evidence_ids": _dump(row.evidence_ids),
                "reason": row.reason,
                "computed_at": row.computed_at,
            },
        )

    def insert_action_row(self, row: PreparationActionRow) -> None:
        self._insert(
            "preparation_actions",
            {
                "id": row.id,
                "skill_id": row.skill_id,
                "target_id": row.target_id,
                "priority": row.priority,
                "reason": row.reason,
                "action": row.action,
                "success_criteria": _dump(row.success_criteria),
                "status": row.status,
                "severity": row.severity,
                "created_at": row.created_at,
                "source_evidence_ids": _dump(row.source_evidence_ids),
                "resources": _dump(row.resources),
            },
        )

    def insert_story_row(self, row: StarStoryRow) -> None:
        self._insert(
            "star_stories",
            {
                "id": row.id,
                "candidate_id": row.candidate_id,
                "title": row.title,
                "situation": row.situation,
                "task": row.task,
                "action": row.action,
                "result": row.result,
                "skill_ids": _dump(row.skill_ids),
                "source": row.source,
                "updated_at": row.updated_at,
            },
        )

    def insert_resume_review_row(self, row: ResumeReviewRow) -> None:
        self._insert(
            "resume_reviews",
            {
                "id": row.id,
                "candidate_id": row.candidate_id,
                "target_id": row.target_id,
                "ats": _dump(row.ats),
                "suggestions": _dump(row.suggestions),
                "tailoring": None if row.tailoring is None else _dump(row.tailoring),
                "linked_gap_skill_ids": _dump(row.linked_gap_skill_ids),
                "guard": _dump(row.guard),
                "created_at": row.created_at,
            },
        )

    def insert_interview_pack_row(self, row: InterviewPackRow) -> None:
        self._insert(
            "interview_packs",
            {
                "id": row.id,
                "data": _dump(row.data),
                "source": row.source,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    def insert_user_question_row(self, row: UserQuestionRow) -> None:
        self._insert(
            "user_questions",
            {
                "id": row.id,
                "skill_id": row.skill_id,
                "text": row.text,
                "difficulty": row.difficulty,
                "mode": row.mode,
                "created_at": row.created_at,
            },
        )

    def insert_external_context_row(self, row: ExternalContextRow) -> None:
        self.insert_external_context(row)

    # --------------------------------------------------- generic row access

    def upsert_skill_node(self, id: str, label: str, parent_id: str | None) -> None:
        """Register a taxonomy node (idempotent) — port of `upsertSkillNode`."""
        existing = self._one("skill_nodes", {"id": id})
        if existing is None:
            self._insert("skill_nodes", {"id": id, "label": label, "parent_id": parent_id})
        else:
            self._update("skill_nodes", {"id": id}, {"label": label, "parent_id": parent_id})

    def list_skill_nodes(self) -> list[dict[str, Any]]:
        return self._many("skill_nodes", order_by="id")

    def get_row(self, table: str, row_id: object) -> dict[str, Any] | None:
        pk = self._primary_key(table)
        if len(pk) != 1:
            raise StoreDataError(table, pk[0] if pk else "id", "composite primary key")
        return self._one(table, {pk[0]: row_id})

    def list_rows(self, table: str) -> list[dict[str, Any]]:
        return self._many(table)

    def insert_row(self, table: str, values: Mapping[str, Any]) -> None:
        self._insert(table, values)

    def update_row(self, table: str, row_id: object, patch: Mapping[str, Any]) -> None:
        self._reject_append_only(table)
        pk = self._primary_key(table)
        if len(pk) != 1:
            raise StoreDataError(table, pk[0] if pk else "id", "composite primary key")
        self._update(table, {pk[0]: row_id}, patch)

    def delete_row(self, table: str, row_id: object) -> None:
        self._reject_append_only(table)
        pk = self._primary_key(table)
        if len(pk) != 1:
            raise StoreDataError(table, pk[0] if pk else "id", "composite primary key")
        table_obj = Base.metadata.tables[table]
        self._write(delete(table_obj).where(table_obj.c[pk[0]] == row_id))

    def delete_rows_where(self, table: str, **equals: Any) -> None:
        self._reject_append_only(table)
        self._check_table(table)
        self._write(delete(Base.metadata.tables[table]).filter_by(**equals))

    def _reject_append_only(self, table: str) -> None:
        if table in APPEND_ONLY_TABLES:
            raise StoreDataError(table, "table", "append-only table cannot be updated or deleted")

    def _many_where(self, table: str, where: Mapping[str, Any]) -> list[dict[str, Any]]:
        self._check_table(table)
        stmt = select(Base.metadata.tables[table]).filter_by(**dict(where))
        with self._read_conn() as conn:
            return [dict(row) for row in conn.execute(stmt).mappings()]


def open_store(path: str | Path) -> Store:
    """Open (creating if needed) the store at `path`; `:memory:` is supported."""

    return Store(path)


def _table_name(statement: str) -> str:
    return statement.split("(", 1)[0].split()[-1]


def _candidate(row: Mapping[str, Any]) -> CandidateRow:
    return CandidateRow(
        id=row["id"],
        active=row["active"],
        name=row["name"],
        headline=row["headline"],
        resume_text=row["resume_text"],
        data=_load_model(CandidateProfile, row["data"], "candidate_profiles", "data"),
        created_at=row["created_at"],
    )


def _target(row: Mapping[str, Any]) -> TargetRow:
    return TargetRow(
        id=row["id"],
        active=row["active"],
        company=row["company"],
        role=row["role"],
        level=row["level"],
        job_description=row["job_description"],
        data=_load_model(TargetRole, row["data"], "target_roles", "data"),
        created_at=row["created_at"],
    )


def _session(row: Mapping[str, Any]) -> SessionRow:
    return SessionRow(
        id=row["id"],
        candidate_id=row["candidate_id"],
        target_id=row["target_id"],
        status=row["status"],
        current_round=row["current_round"],
        planned_questions=row["planned_questions"],
        mode=row["mode"],
        round_type=row["round_type"],
        focus_skill_id=row["focus_skill_id"],
        action_id=row["action_id"],
        mode_state=_load(_MODE_STATE, row["mode_state"], "interview_sessions", "mode_state"),
        loop_id=row["loop_id"],
        loop_round=row["loop_round"],
        context_id=row["context_id"],
        focus_skills=_load(_SKILL_LIST, row["focus_skills"], "interview_sessions", "focus_skills"),
        created_at=row["created_at"],
        completed_at=row["completed_at"],
        plugin_mode_id=row["plugin_mode_id"],
    )


def _question(row: Mapping[str, Any]) -> QuestionRow:
    return QuestionRow(
        id=row["id"],
        session_id=row["session_id"],
        skill_id=row["skill_id"],
        topic=row["topic"],
        text=row["text"],
        sub_skills=_load(_SKILL_LIST, row["sub_skills"], "interview_questions", "sub_skills"),
        expected_concepts=_load(
            _CONCEPT_LIST, row["expected_concepts"], "interview_questions", "expected_concepts"
        ),
        difficulty=row["difficulty"],
        selection_priority=row["selection_priority"],
        selection_reason=row["selection_reason"],
        selection_factors=_load(
            _FACTORS, row["selection_factors"], "interview_questions", "selection_factors"
        ),
        follow_up_of=row["follow_up_of"],
        follow_up_focus=row["follow_up_focus"],
        extra=_load(_FACTORS, row["extra"], "interview_questions", "extra"),
        position=row["position"],
        created_at=row["created_at"],
    )


def _answer(row: Mapping[str, Any]) -> AnswerRow:
    voice = row["voice"]
    reviews = row["plugin_reviews"]
    fields = row["fields"]
    return AnswerRow(
        id=row["id"],
        question_id=row["question_id"],
        session_id=row["session_id"],
        text=row["text"],
        code=row["code"],
        language=row["language"],
        status=row["status"],
        created_at=row["created_at"],
        voice=(
            None if voice is None else _load_model(AnswerVoice, voice, "candidate_answers", "voice")
        ),
        plugin_reviews=(
            None
            if reviews is None
            else _load(_REVIEW_LIST, reviews, "candidate_answers", "plugin_reviews")
        ),
        fields=None if fields is None else _load(_FIELDS, fields, "candidate_answers", "fields"),
    )


def _evaluation(row: Mapping[str, Any]) -> EvaluationRow:
    return EvaluationRow(
        id=row["id"],
        answer_id=row["answer_id"],
        question_id=row["question_id"],
        session_id=row["session_id"],
        data=_load_model(AnswerEvaluation, row["data"], "answer_evaluations", "data"),
        readiness_delta=_load(
            _DELTA_LIST, row["readiness_delta"], "answer_evaluations", "readiness_delta"
        ),
        created_at=row["created_at"],
    )


def _evidence(row: Mapping[str, Any]) -> EvidenceRow:
    return EvidenceRow(
        id=row["id"],
        candidate_id=row["candidate_id"],
        skill_id=row["skill_id"],
        type=row["type"],
        score=row["score"],
        confidence=row["confidence"],
        observation=row["observation"],
        session_id=row["session_id"],
        question_id=row["question_id"],
        source=row["source"],
        created_at=row["created_at"],
    )


def _runtime_session(row: Mapping[str, Any]) -> RuntimeSessionRow:
    return RuntimeSessionRow(
        id=row["id"],
        session_id=row["session_id"],
        runtime=row["runtime"],
        runtime_session_id=row["runtime_session_id"],
        thread_id=row["thread_id"],
        status=row["status"],
        created_at=row["created_at"],
    )


def _ai_usage(row: Mapping[str, Any]) -> AIUsageRow:
    return AIUsageRow(
        id=row["id"],
        runtime_kind=row["runtime_kind"],
        provider_session_id=row["provider_session_id"],
        interview_session_id=row["interview_session_id"],
        task_id=row["task_id"],
        model=row["model"],
        attempt=row["attempt"],
        ok=row["ok"],
        error_code=row["error_code"],
        input_tokens=row["input_tokens"],
        output_tokens=row["output_tokens"],
        thought_tokens=row["thought_tokens"],
        cached_read_tokens=row["cached_read_tokens"],
        cached_write_tokens=row["cached_write_tokens"],
        total_tokens=row["total_tokens"],
        context_used=row["context_used"],
        context_size=row["context_size"],
        cost_amount=row["cost_amount"],
        cost_currency=row["cost_currency"],
        stop_reason=row["stop_reason"],
        duration_ms=row["duration_ms"],
        created_at=row["created_at"],
    )


def _readiness(row: Mapping[str, Any]) -> ReadinessRow:
    return ReadinessRow(
        id=row["id"],
        skill_id=row["skill_id"],
        score=row["score"],
        confidence=row["confidence"],
        evidence_ids=_load(_STR_LIST, row["evidence_ids"], "readiness_scores", "evidence_ids"),
        reason=row["reason"],
        computed_at=row["computed_at"],
    )


def _action(row: Mapping[str, Any]) -> PrepActionRow:
    return PrepActionRow(
        id=row["id"],
        skill_id=row["skill_id"],
        target_id=row["target_id"],
        priority=row["priority"],
        reason=row["reason"],
        action=row["action"],
        success_criteria=_load(
            _STR_LIST, row["success_criteria"], "preparation_actions", "success_criteria"
        ),
        status=row["status"],
        severity=row["severity"],
        created_at=row["created_at"],
        source_evidence_ids=_load(
            _STR_LIST, row["source_evidence_ids"], "preparation_actions", "source_evidence_ids"
        ),
        resources=_load(_RESOURCE_LIST, row["resources"], "preparation_actions", "resources"),
        source=row["source"],
    )


def _loop(row: Mapping[str, Any]) -> InterviewLoopRow:
    return InterviewLoopRow(
        id=row["id"],
        target_id=row["target_id"],
        company_profile_id=row["company_profile_id"],
        rounds=_load(_ROUND_LIST, row["rounds"], "interview_loops", "rounds"),
        status=row["status"],
        pack_id=row["pack_id"],
        focus_skills=_load(_SKILL_LIST, row["focus_skills"], "interview_loops", "focus_skills"),
        current_round=row["current_round"],
        abandoned=row["abandoned"],
        debrief=_load(_ANY, row["debrief"], "interview_loops", "debrief"),
        created_at=row["created_at"],
        completed_at=row["completed_at"],
    )


def _debrief(row: Mapping[str, Any]) -> InterviewDebriefRow:
    return InterviewDebriefRow(
        id=row["id"],
        session_id=row["session_id"],
        data=_load(_ANY, row["data"], "interview_debriefs", "data"),
        created_at=row["created_at"],
    )


def _story(row: Mapping[str, Any]) -> StarStoryRow:
    return StarStoryRow(
        id=row["id"],
        candidate_id=row["candidate_id"],
        title=row["title"],
        situation=row["situation"],
        task=row["task"],
        action=row["action"],
        result=row["result"],
        skill_ids=_load(_SKILL_LIST, row["skill_ids"], "star_stories", "skill_ids"),
        source=row["source"],
        updated_at=row["updated_at"],
    )


def _resume_review(row: Mapping[str, Any]) -> ResumeReviewRow:
    return ResumeReviewRow(
        id=row["id"],
        candidate_id=row["candidate_id"],
        target_id=row["target_id"],
        ats=_load(_ANY, row["ats"], "resume_reviews", "ats"),
        suggestions=_load(_ANY, row["suggestions"], "resume_reviews", "suggestions"),
        tailoring=_load(_ANY, row["tailoring"], "resume_reviews", "tailoring"),
        linked_gap_skill_ids=_load(
            _STR_LIST, row["linked_gap_skill_ids"], "resume_reviews", "linked_gap_skill_ids"
        ),
        guard=_load(_ANY, row["guard"], "resume_reviews", "guard"),
        created_at=row["created_at"],
    )


def _interview_pack(row: Mapping[str, Any]) -> InterviewPackRow:
    return InterviewPackRow(
        id=row["id"],
        data=_load(_ANY, row["data"], "interview_packs", "data"),
        source=row["source"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _user_question(row: Mapping[str, Any]) -> UserQuestionRow:
    return UserQuestionRow(
        id=row["id"],
        skill_id=row["skill_id"],
        text=row["text"],
        difficulty=row["difficulty"],
        mode=row["mode"],
        created_at=row["created_at"],
    )


def _mcp_server(row: Mapping[str, Any]) -> McpServerRow:
    return McpServerRow(
        id=row["id"],
        enabled=row["enabled"],
        allowed_tools=_load(_STR_LIST, row["allowed_tools"], "mcp_servers", "allowed_tools"),
        updated_at=row["updated_at"],
    )


def _external_context(row: Mapping[str, Any]) -> ExternalContextRow:
    return ExternalContextRow(
        id=row["id"],
        server_id=row["server_id"],
        tool=row["tool"],
        title=row["title"],
        text=row["text"],
        created_at=row["created_at"],
    )


def _plugin_install(row: Mapping[str, Any]) -> PluginInstallRow:
    return PluginInstallRow(
        id=row["id"],
        enabled=row["enabled"],
        granted_permissions=_load(
            _PERMISSION_LIST, row["granted_permissions"], "plugin_installs", "granted_permissions"
        ),
        source=row["source"],
        source_url=row["source_url"],
        dir_name=row["dir_name"],
        installed_at=row["installed_at"],
        updated_at=row["updated_at"],
    )


def _plugin_setting(row: Mapping[str, Any]) -> PluginSettingRow:
    return PluginSettingRow(
        plugin_id=row["plugin_id"],
        key=row["key"],
        value=_load(_ANY, row["value"], "plugin_settings", "value"),
    )


def _plugin_storage(row: Mapping[str, Any]) -> PluginStorageRow:
    return PluginStorageRow(
        plugin_id=row["plugin_id"],
        key=row["key"],
        value=_load(_ANY, row["value"], "plugin_storage", "value"),
    )
