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
    CamelModel,
    CandidateProfile,
    ExpectedConcept,
    JsonScalar,
    ModeState,
    PrepResource,
    TargetRole,
    VoiceFeedback,
    VoiceMetrics,
)
from ..core.skill_id import SkillId
from .schema import BASELINE_DDL, TABLE_NAMES, Base

__all__ = [
    "APPEND_ONLY_TABLES",
    "AnswerPluginReview",
    "AnswerRow",
    "AnswerVoice",
    "CandidateRow",
    "EvaluationRow",
    "EvidenceRow",
    "PrepActionRow",
    "QuestionRow",
    "ReadinessDeltaEntry",
    "ReadinessRow",
    "SessionRow",
    "Store",
    "StoreDataError",
    "TargetRow",
    "open_store",
]

_MEMORY = ":memory:"

# Invariant #3: readiness snapshots are appended, never overwritten.
APPEND_ONLY_TABLES = ("readiness_scores",)


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


_STR_LIST = TypeAdapter(list[str])
_SKILL_LIST = TypeAdapter(list[SkillId])
_CONCEPT_LIST = TypeAdapter(list[ExpectedConcept])
_RESOURCE_LIST = TypeAdapter(list[PrepResource])
_DELTA_LIST = TypeAdapter(list[ReadinessDeltaEntry])
_REVIEW_LIST = TypeAdapter(list[AnswerPluginReview])
_MODE_STATE = TypeAdapter(ModeState)
_FACTORS = TypeAdapter(dict[str, Any])
_FIELDS = TypeAdapter(dict[str, JsonScalar])


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


def _dump(value: BaseModel | list[Any] | dict[str, Any] | str) -> str:
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

    # --------------------------------------------------- generic row access

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
