"""SQLAlchemy 2 typed tables for the Interview OS SQLite database.

Port of `apps/server/src/orchestrator/store/schema.ts`. Table and column names,
types, nullability and defaults match the drizzle schema exactly — the Python
backend opens the same `data/*.db` file with no data loss.

JSON columns are SQLite `TEXT` holding JSON strings (drizzle `{ mode: "json" }`);
`store.py` serializes and deserializes them.

`BASELINE_DDL` is the exact DDL the current server creates (captured from
`sqlite_master` of a freshly booted server) and is what the Alembic baseline
revision and `Store.migrate()` execute.
"""

from __future__ import annotations

from sqlalchemy import REAL, Integer, MetaData, Text
from sqlalchemy import text as sql_text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

__all__ = [
    "BASELINE_DDL",
    "Base",
    "AnswerEvaluation",
    "CandidateAnswer",
    "CandidateProfile",
    "ExternalContext",
    "InterviewDebrief",
    "InterviewLoop",
    "InterviewPack",
    "InterviewQuestion",
    "InterviewSession",
    "McpServer",
    "PluginInstall",
    "PluginSetting",
    "PluginStorage",
    "PreparationAction",
    "ReadinessScore",
    "ResumeReview",
    "RuntimeSession",
    "Setting",
    "SkillEvidence",
    "SkillNode",
    "StarStory",
    "TargetRole",
    "UsageEvent",
    "UserQuestion",
]

BASELINE_DDL: tuple[str, ...] = (
    """CREATE TABLE candidate_profiles (
  id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0,
  name TEXT, headline TEXT,
  resume_text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)
""",
    """CREATE TABLE target_roles (
  id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0,
  company TEXT NOT NULL, role TEXT NOT NULL, level TEXT NOT NULL,
  job_description TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)
""",
    """CREATE TABLE interview_sessions (
  id TEXT PRIMARY KEY, candidate_id TEXT, target_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  current_round INTEGER NOT NULL DEFAULT 0,
  planned_questions INTEGER NOT NULL DEFAULT 4,
  mode TEXT NOT NULL DEFAULT 'interview',
  round_type TEXT NOT NULL DEFAULT 'mixed',
  focus_skill_id TEXT, action_id TEXT,
  mode_state TEXT NOT NULL DEFAULT '{}',
  loop_id TEXT, loop_round INTEGER,
  context_id TEXT, focus_skills TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, completed_at TEXT
, plugin_mode_id TEXT)
""",
    """CREATE TABLE interview_loops (
  id TEXT PRIMARY KEY, target_id TEXT,
  company_profile_id TEXT NOT NULL DEFAULT 'generic',
  rounds TEXT NOT NULL DEFAULT '[]',
  pack_id TEXT, focus_skills TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'planned',
  current_round INTEGER NOT NULL DEFAULT 0,
  abandoned INTEGER NOT NULL DEFAULT 0,
  debrief TEXT,
  created_at TEXT NOT NULL, completed_at TEXT
)
""",
    """CREATE TABLE resume_reviews (
  id TEXT PRIMARY KEY, candidate_id TEXT, target_id TEXT,
  ats TEXT NOT NULL, suggestions TEXT NOT NULL DEFAULT '[]',
  tailoring TEXT, linked_gap_skill_ids TEXT NOT NULL DEFAULT '[]',
  guard TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
)
""",
    """CREATE TABLE usage_events (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at TEXT NOT NULL
)
""",
    """CREATE TABLE interview_questions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, skill_id TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
  sub_skills TEXT NOT NULL DEFAULT '[]', expected_concepts TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  selection_priority REAL, selection_reason TEXT,
  selection_factors TEXT NOT NULL DEFAULT '{}',
  follow_up_of TEXT, follow_up_focus TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
)
""",
    """CREATE TABLE candidate_answers (
  id TEXT PRIMARY KEY, question_id TEXT NOT NULL, session_id TEXT NOT NULL,
  text TEXT NOT NULL, code TEXT, language TEXT,
  status TEXT NOT NULL DEFAULT 'evaluated',
  created_at TEXT NOT NULL
, voice TEXT, plugin_reviews TEXT, fields TEXT)
""",
    """CREATE TABLE answer_evaluations (
  id TEXT PRIMARY KEY, answer_id TEXT NOT NULL, question_id TEXT NOT NULL,
  session_id TEXT NOT NULL, data TEXT NOT NULL,
  readiness_delta TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
)
""",
    """CREATE TABLE skill_nodes (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, parent_id TEXT
)
""",
    """CREATE TABLE skill_evidence (
  id TEXT PRIMARY KEY, candidate_id TEXT, skill_id TEXT NOT NULL,
  type TEXT NOT NULL, score REAL NOT NULL, confidence REAL NOT NULL,
  observation TEXT NOT NULL DEFAULT '', session_id TEXT, question_id TEXT,
  source TEXT,
  created_at TEXT NOT NULL
)
""",
    """CREATE TABLE plugin_installs (
  id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
  granted_permissions TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL, source_url TEXT, dir_name TEXT,
  installed_at TEXT, updated_at TEXT
)
""",
    """CREATE TABLE readiness_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL,
  score REAL, confidence REAL NOT NULL,
  evidence_ids TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL
)
""",
    """CREATE TABLE preparation_actions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, target_id TEXT, priority REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
  success_criteria TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL, source_evidence_ids TEXT NOT NULL DEFAULT '[]',
  resources TEXT NOT NULL DEFAULT '[]'
, source TEXT NOT NULL DEFAULT 'planner')
""",
    """CREATE TABLE interview_packs (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, source TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
""",
    """CREATE TABLE user_questions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, text TEXT NOT NULL,
  difficulty TEXT, mode TEXT, created_at TEXT NOT NULL
)
""",
    """CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runtime TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
)
""",
    """CREATE TABLE interview_debriefs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
)
""",
    """CREATE TABLE star_stories (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL,
  title TEXT NOT NULL,
  situation TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
  skill_ids TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user', updated_at TEXT NOT NULL
)
""",
    """CREATE TABLE settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
)
""",
    """CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
  allowed_tools TEXT NOT NULL DEFAULT '[]', updated_at TEXT
)
""",
    """CREATE TABLE external_contexts (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL, tool TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)
""",
    """CREATE TABLE plugin_settings (
  plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
)
""",
    """CREATE TABLE plugin_storage (
  plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
)
""",
)


class Base(DeclarativeBase):
    metadata = MetaData()


class CandidateProfile(Base):
    __tablename__ = "candidate_profiles"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    active: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    name: Mapped[str | None] = mapped_column(Text)
    headline: Mapped[str | None] = mapped_column(Text)
    resume_text: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    data: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'{}'"))
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class TargetRole(Base):
    __tablename__ = "target_roles"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    active: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    company: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    level: Mapped[str] = mapped_column(Text, nullable=False)
    job_description: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("''")
    )
    data: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'{}'"))
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class InterviewSession(Base):
    __tablename__ = "interview_sessions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    candidate_id: Mapped[str | None] = mapped_column(Text)
    target_id: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'created'"))
    current_round: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=sql_text("0")
    )
    planned_questions: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=sql_text("4")
    )
    mode: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'interview'"))
    round_type: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'mixed'")
    )
    focus_skill_id: Mapped[str | None] = mapped_column(Text)
    action_id: Mapped[str | None] = mapped_column(Text)
    mode_state: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'{}'"))
    loop_id: Mapped[str | None] = mapped_column(Text)
    loop_round: Mapped[int | None] = mapped_column(Integer)
    context_id: Mapped[str | None] = mapped_column(Text)
    focus_skills: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'[]'"))
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    completed_at: Mapped[str | None] = mapped_column(Text)
    plugin_mode_id: Mapped[str | None] = mapped_column(Text)


class InterviewLoop(Base):
    __tablename__ = "interview_loops"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    target_id: Mapped[str | None] = mapped_column(Text)
    company_profile_id: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'generic'")
    )
    rounds: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'[]'"))
    pack_id: Mapped[str | None] = mapped_column(Text)
    focus_skills: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'[]'"))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'planned'"))
    current_round: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=sql_text("0")
    )
    abandoned: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    debrief: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    completed_at: Mapped[str | None] = mapped_column(Text)


class InterviewQuestion(Base):
    __tablename__ = "interview_questions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    skill_id: Mapped[str] = mapped_column(Text, nullable=False)
    topic: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    text: Mapped[str] = mapped_column(Text, nullable=False)
    sub_skills: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'[]'"))
    expected_concepts: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'[]'")
    )
    difficulty: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'medium'")
    )
    selection_priority: Mapped[float | None] = mapped_column(REAL)
    selection_reason: Mapped[str | None] = mapped_column(Text)
    selection_factors: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'{}'")
    )
    follow_up_of: Mapped[str | None] = mapped_column(Text)
    follow_up_focus: Mapped[str | None] = mapped_column(Text)
    extra: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'{}'"))
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class CandidateAnswer(Base):
    __tablename__ = "candidate_answers"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    question_id: Mapped[str] = mapped_column(Text, nullable=False)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    code: Mapped[str | None] = mapped_column(Text)
    language: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'evaluated'")
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    voice: Mapped[str | None] = mapped_column(Text)
    plugin_reviews: Mapped[str | None] = mapped_column(Text)
    fields: Mapped[str | None] = mapped_column(Text)


class AnswerEvaluation(Base):
    __tablename__ = "answer_evaluations"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    answer_id: Mapped[str] = mapped_column(Text, nullable=False)
    question_id: Mapped[str] = mapped_column(Text, nullable=False)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[str] = mapped_column(Text, nullable=False)
    readiness_delta: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'[]'")
    )
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class SkillNode(Base):
    __tablename__ = "skill_nodes"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    parent_id: Mapped[str | None] = mapped_column(Text)


class SkillEvidence(Base):
    __tablename__ = "skill_evidence"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    candidate_id: Mapped[str | None] = mapped_column(Text)
    skill_id: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    score: Mapped[float] = mapped_column(REAL, nullable=False)
    confidence: Mapped[float] = mapped_column(REAL, nullable=False)
    observation: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    session_id: Mapped[str | None] = mapped_column(Text)
    question_id: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class PluginInstall(Base):
    __tablename__ = "plugin_installs"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    enabled: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    granted_permissions: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'[]'")
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text)
    dir_name: Mapped[str | None] = mapped_column(Text)
    installed_at: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[str | None] = mapped_column(Text)


class ReadinessScore(Base):
    __tablename__ = "readiness_scores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(Text, nullable=False)
    score: Mapped[float | None] = mapped_column(REAL)
    confidence: Mapped[float] = mapped_column(REAL, nullable=False)
    evidence_ids: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'[]'"))
    reason: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    computed_at: Mapped[str] = mapped_column(Text, nullable=False)


class PreparationAction(Base):
    __tablename__ = "preparation_actions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    skill_id: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[str | None] = mapped_column(Text)
    priority: Mapped[float] = mapped_column(REAL, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    action: Mapped[str] = mapped_column(Text, nullable=False)
    success_criteria: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'[]'")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'open'"))
    severity: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'medium'"))
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    source_evidence_ids: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'[]'")
    )
    resources: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'[]'"))
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'planner'"))


class PluginSetting(Base):
    __tablename__ = "plugin_settings"

    plugin_id: Mapped[str] = mapped_column(Text, primary_key=True)
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class PluginStorage(Base):
    __tablename__ = "plugin_storage"

    plugin_id: Mapped[str] = mapped_column(Text, primary_key=True)
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class RuntimeSession(Base):
    __tablename__ = "runtime_sessions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    runtime: Mapped[str] = mapped_column(Text, nullable=False)
    runtime_session_id: Mapped[str] = mapped_column(Text, nullable=False)
    thread_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'open'"))
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class InterviewDebrief(Base):
    __tablename__ = "interview_debriefs"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class StarStory(Base):
    __tablename__ = "star_stories"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    candidate_id: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    situation: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    task: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    action: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    result: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    skill_ids: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'[]'"))
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'user'"))
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class ResumeReview(Base):
    __tablename__ = "resume_reviews"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    candidate_id: Mapped[str | None] = mapped_column(Text)
    target_id: Mapped[str | None] = mapped_column(Text)
    ats: Mapped[str] = mapped_column(Text, nullable=False)
    suggestions: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'[]'"))
    tailoring: Mapped[str | None] = mapped_column(Text)
    linked_gap_skill_ids: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'[]'")
    )
    guard: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("'{}'"))
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class InterviewPack(Base):
    __tablename__ = "interview_packs"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    data: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[str] = mapped_column(Text, nullable=False)


class UserQuestion(Base):
    __tablename__ = "user_questions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    skill_id: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    difficulty: Mapped[str | None] = mapped_column(Text)
    mode: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class McpServer(Base):
    __tablename__ = "mcp_servers"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    enabled: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql_text("0"))
    allowed_tools: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=sql_text("'[]'")
    )
    updated_at: Mapped[str | None] = mapped_column(Text)


class ExternalContext(Base):
    __tablename__ = "external_contexts"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    server_id: Mapped[str] = mapped_column(Text, nullable=False)
    tool: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    text: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql_text("''"))
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


class UsageEvent(Base):
    __tablename__ = "usage_events"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    event: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, nullable=False)


# Every table the baseline creates, in creation order (checked against
# `BASELINE_DDL` and the SQLAlchemy metadata by `tests/test_schema_parity.py`).
TABLE_NAMES: tuple[str, ...] = (
    "candidate_profiles",
    "target_roles",
    "interview_sessions",
    "interview_loops",
    "resume_reviews",
    "usage_events",
    "interview_questions",
    "candidate_answers",
    "answer_evaluations",
    "skill_nodes",
    "skill_evidence",
    "plugin_installs",
    "readiness_scores",
    "preparation_actions",
    "interview_packs",
    "user_questions",
    "runtime_sessions",
    "interview_debriefs",
    "star_stories",
    "settings",
    "mcp_servers",
    "external_contexts",
    "plugin_settings",
    "plugin_storage",
)
