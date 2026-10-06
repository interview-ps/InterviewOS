"""postgres-interviewer — a deterministic PostgreSQL question bank (phase-7 port).

Ports the former `index.ts`: a `questions.suggest` bank, `ui.render` declarative
contributions, `ui.frameRun` stateless frame calls, `evaluation.review`
observations, and the legacy `execute` self-check evidence path.
"""

from __future__ import annotations

import re
from typing import Any

from interview_os.core.plugin_api import (
    CandidateLite,
    EvaluationReviewAnswer,
    EvaluationReviewRequest,
    EvaluationReviewResponse,
    PluginReviewObservation,
    QuestionsSuggestRequest,
    QuestionsSuggestResponse,
    UiFrameRunRequest,
    UiFrameRunResponse,
    UiRenderRequest,
    UiRenderResponse,
)
from interview_os.plugins.dispatch import current_plugin_settings

__all__ = ["QUESTIONS", "PostgresInterviewer", "execute", "setup"]

QUESTIONS: list[dict[str, Any]] = [
    {
        "id": "pg-idx-1",
        "skillId": "sql.indexing",
        "text": "How does a B-tree index speed up equality and range lookups in PostgreSQL?",
        "difficulty": "medium",
        "expectedConcepts": ["b-tree", "ordered keys", "page lookups"],
    },
    {
        "id": "pg-idx-2",
        "skillId": "sql.indexing",
        "text": "When would you choose a partial index over a full index?",
        "difficulty": "medium",
        "expectedConcepts": ["index size", "predicate selectivity"],
    },
    {
        "id": "pg-idx-3",
        "skillId": "sql.indexing",
        "text": "Why can a composite index on (a, b) fail to help a query filtering only on b?",
        "difficulty": "hard",
        "expectedConcepts": ["leftmost prefix", "column order"],
    },
    {
        "id": "pg-txn-1",
        "skillId": "sql.transactions",
        "text": "Explain the difference between READ COMMITTED and REPEATABLE READ in PostgreSQL.",
        "difficulty": "medium",
        "expectedConcepts": ["snapshot", "isolation levels"],
    },
    {
        "id": "pg-txn-2",
        "skillId": "sql.transactions",
        "text": "What is a serialization anomaly and how does SERIALIZABLE prevent it?",
        "difficulty": "hard",
        "expectedConcepts": ["write skew", "predicate locks"],
    },
    {
        "id": "pg-txn-3",
        "skillId": "sql.transactions",
        "text": "How does MVCC let readers and writers avoid blocking each other?",
        "difficulty": "medium",
        "expectedConcepts": ["snapshots", "tuple versions"],
    },
    {
        "id": "pg-opt-1",
        "skillId": "sql.query-optimization",
        "text": "Walk through how you would read an EXPLAIN ANALYZE plan for a slow join.",
        "difficulty": "medium",
        "expectedConcepts": ["node types", "estimates vs actual", "buffers"],
    },
    {
        "id": "pg-opt-2",
        "skillId": "sql.query-optimization",
        "text": "Why might the planner choose a sequential scan over an index scan?",
        "difficulty": "medium",
        "expectedConcepts": ["cost model", "selectivity", "random I/O"],
    },
    {
        "id": "pg-opt-3",
        "skillId": "sql.query-optimization",
        "text": "What do VACUUM and ANALYZE do, and what breaks when statistics are stale?",
        "difficulty": "medium",
        "expectedConcepts": ["dead tuples", "statistics", "autovacuum"],
    },
    {
        "id": "pg-gen-1",
        "skillId": "sql",
        "text": "How do write-ahead logs make PostgreSQL crash-safe?",
        "difficulty": "hard",
        "expectedConcepts": ["wal", "replay", "durability"],
    },
]

SQL_SKILLS = ["sql", "sql.query-optimization", "sql.indexing", "sql.transactions", "sql.locking"]

TAB_SKILLS: list[dict[str, Any]] = [
    {"label": "Queries", "skills": ["sql", "sql.query-optimization"]},
    {"label": "Indexes", "skills": ["sql.indexing"]},
    {"label": "Transactions", "skills": ["sql.transactions"]},
    {"label": "Locking", "skills": ["sql.locking"]},
]

REVIEW_KEYWORDS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"\bexplain(\s+analyze)?\b|query plan", re.IGNORECASE),
        "Referenced the query planner — good instinct for a PostgreSQL round.",
    ),
    (
        re.compile(r"\bmvcc|snapshot|isolation level", re.IGNORECASE),
        "Touched on MVCC/isolation — core PostgreSQL transaction knowledge.",
    ),
    (
        re.compile(r"\bb-?tree|index(es)?\b", re.IGNORECASE),
        "Mentioned indexing — make sure to tie it to selectivity and cost.",
    ),
]

_RANK = {"easy": 0, "medium": 1, "hard": 2}


def _in_scope(skill_id: str | None) -> list[dict[str, Any]]:
    if skill_id is None:
        return list(QUESTIONS)
    return [
        q
        for q in QUESTIONS
        if q["skillId"] == skill_id or str(q["skillId"]).startswith(f"{skill_id}.")
    ]


def _candidate(question: dict[str, Any]) -> CandidateLite:
    return CandidateLite(
        skill_id=question["skillId"],
        text=question["text"],
        difficulty=question["difficulty"],
        expected_concepts=list(question["expectedConcepts"]),
    )


def readiness_card(readiness: dict[str, Any]) -> dict[str, Any]:
    dims = [
        readiness[skill]
        for skill in SQL_SKILLS
        if isinstance(readiness.get(skill), dict) and readiness[skill].get("score") is not None
    ]
    mean = (
        sum(float(dim.get("score") or 0) for dim in dims) / len(dims) if dims else None
    )
    action = {
        "type": "button",
        "label": "Start PostgreSQL Deep Dive",
        "variant": "secondary",
        "action": {"type": "startInterview", "modeId": "pg-deep-dive"},
    }
    if mean is None:
        # No evidence: say so in words instead of an oversized em-dash score.
        return {
            "type": "card",
            "title": "PostgreSQL readiness",
            "subtitle": "Not assessed yet",
            "children": [
                {
                    "type": "text",
                    "text": "No SQL skills assessed yet — run a PostgreSQL interview to get a baseline.",
                },
                action,
            ],
        }
    tone = "green" if mean >= 0.6 else "blue" if mean >= 0.4 else "amber"
    return {
        "type": "card",
        "title": "PostgreSQL readiness",
        "subtitle": f"{len(dims)} SQL skills assessed",
        "children": [
            {
                "type": "stat",
                "label": "Average score",
                "value": f"{round(mean * 100)}%",
                "tone": tone,
            },
            action,
        ],
    }


def explain_analyze() -> dict[str, Any]:
    return {
        "type": "card",
        "title": "Practice EXPLAIN ANALYZE",
        "subtitle": "Read real query plans like a PostgreSQL DBA.",
        "children": [
            {
                "type": "text",
                "text": (
                    "Practice interpreting EXPLAIN ANALYZE output: node types, "
                    "estimates vs actuals, buffers."
                ),
            },
            {
                "type": "button",
                "label": "Start practice",
                "variant": "secondary",
                "action": {"type": "startPractice", "skillId": "sql.query-optimization"},
            },
        ],
    }


def home_page(readiness: dict[str, Any], gaps: list[dict[str, Any]]) -> dict[str, Any]:
    weaknesses = [
        {
            "text": f"{gap.get('label') or gap.get('skillId')}"
            + (f" ({gap['severity']})" if gap.get("severity") else ""),
            "tone": "amber" if gap.get("severity") == "high" else "muted",
        }
        for gap in gaps
        if isinstance(gap.get("skillId"), str)
        and any(
            gap["skillId"] == skill or str(gap["skillId"]).startswith(f"{skill}.")
            for skill in SQL_SKILLS
        )
    ][:5]
    tabs = [
        {
            "label": tab["label"],
            "children": [
                {
                    "type": "stack",
                    "gap": "sm",
                    "children": [
                        {
                            "type": "skillScore",
                            "skillId": skill,
                            "label": (readiness.get(skill) or {}).get("label") or skill,
                            "score": (readiness.get(skill) or {}).get("score"),
                            "confidence": (readiness.get(skill) or {}).get("confidence") or 0,
                        }
                        for skill in tab["skills"]
                    ],
                }
            ],
        }
        for tab in TAB_SKILLS
    ]
    tail: dict[str, Any] = (
        {
            "type": "card",
            "title": "Recent weaknesses",
            "children": [{"type": "list", "items": weaknesses}],
        }
        if weaknesses
        else {
            "type": "emptyState",
            "title": "No PostgreSQL weaknesses detected",
            "description": "SQL skills are on track.",
        }
    )
    return {
        "type": "stack",
        "gap": "md",
        "children": [
            {"type": "tabs", "tabs": tabs},
            {"type": "divider"},
            tail,
        ],
    }


def _render_component(
    component: str, readiness: dict[str, Any], gaps: list[dict[str, Any]]
) -> dict[str, Any]:
    if component == "readiness-card":
        return readiness_card(readiness)
    if component == "explain-analyze":
        return explain_analyze()
    if component == "home":
        return home_page(readiness, gaps)
    return {"type": "emptyState", "title": "Unknown component"}


class PostgresInterviewer:
    """Middleware implementing the plugin's four hooks."""

    async def questions_suggest(self, req: QuestionsSuggestRequest) -> QuestionsSuggestResponse:
        bias = str(current_plugin_settings().get("difficulty-bias") or "medium")
        rank = _RANK.get(bias, 1)
        in_scope = _in_scope(str(req.skill_id))
        ranked = sorted(
            in_scope, key=lambda q: abs(_RANK[q["difficulty"]] - rank)
        )
        limit = req.count if req.count > 0 else len(in_scope)
        return QuestionsSuggestResponse(questions=[_candidate(q) for q in ranked[:limit]])

    async def ui_render(self, req: UiRenderRequest) -> UiRenderResponse:
        params = req.params if isinstance(req.params, dict) else {}
        readiness = params.get("readiness") if isinstance(params.get("readiness"), dict) else {}
        gaps = params.get("gaps") if isinstance(params.get("gaps"), list) else []
        return UiRenderResponse(ui=_render_component(req.component, readiness, gaps))

    async def ui_frame_run(self, req: UiFrameRunRequest) -> UiFrameRunResponse:
        inner = req.request if isinstance(req.request, dict) else {}
        skill_id = inner.get("skillId") if isinstance(inner.get("skillId"), str) else None
        in_scope = _in_scope(skill_id)
        count = inner.get("count")
        limit = count if isinstance(count, int) and count > 0 else len(in_scope)
        return UiFrameRunResponse(output={"questions": in_scope[:limit]})

    async def evaluation_review(
        self, req: EvaluationReviewRequest
    ) -> EvaluationReviewResponse:
        observations: list[PluginReviewObservation] = []
        answer: EvaluationReviewAnswer | None = req.answer
        if answer is None:
            observations.append(
                PluginReviewObservation(
                    text=(
                        "Answer text unavailable — grant answers.read to include "
                        "it in PostgreSQL reviews."
                    ),
                    tone="muted",
                )
            )
        else:
            for pattern, text in REVIEW_KEYWORDS:
                if pattern.search(answer.text):
                    observations.append(PluginReviewObservation(text=text, tone="green"))
            if not observations:
                observations.append(
                    PluginReviewObservation(
                        text="No PostgreSQL-specific concepts detected in this answer.",
                        tone="amber",
                    )
                )
        return EvaluationReviewResponse(observations=observations[:5])


def execute(input: object, request: object) -> dict[str, Any]:
    """Legacy self-check path (kept for parity with the former `index.ts`)."""

    data = input if isinstance(input, dict) else {}
    req = request if isinstance(request, dict) else {}
    readiness = data.get("readiness") if isinstance(data.get("readiness"), dict) else {}
    gaps = data.get("gaps") if isinstance(data.get("gaps"), list) else []

    if req.get("kind") == "ui":
        return {"ui": _render_component(str(req.get("component", "")), readiness, gaps)}
    if req.get("kind") == "ui-frame":
        in_scope = _in_scope(req.get("skillId") if isinstance(req.get("skillId"), str) else None)
        count = req.get("count")
        limit = count if isinstance(count, int) and count > 0 else len(in_scope)
        return {"output": {"questions": in_scope[:limit]}}

    in_scope = _in_scope(req.get("skillId") if isinstance(req.get("skillId"), str) else None)
    count = req.get("count")
    limit = count if isinstance(count, int) and count > 0 else len(in_scope)
    result: dict[str, Any] = {"questions": in_scope[:limit]}
    self_check = req.get("selfCheck")
    if isinstance(self_check, list):
        proposals = [
            {
                "skillId": item["skillId"],
                "score": 0.7 if item["passed"] else 0.3,
                "confidence": 0.4,
                "observation": (
                    f"PostgreSQL self-check {'passed' if item['passed'] else 'failed'} "
                    f"on {item['skillId']}"
                ),
            }
            for item in self_check
            if isinstance(item, dict)
            and isinstance(item.get("skillId"), str)
            and isinstance(item.get("passed"), bool)
        ]
        result["evidenceProposals"] = proposals
    return result


def setup(ctx: Any) -> None:
    ctx.middleware(PostgresInterviewer())
