"""postgres-interviewer port tests (phase 7)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import cast

from interview_os.core.models import AnswerEvaluation
from interview_os.core.plugin_api import (
    EvaluationReviewAnswer,
    EvaluationReviewQuestion,
    EvaluationReviewRequest,
    EvaluationReviewResponse,
    QuestionsSuggestRequest,
    QuestionsSuggestResponse,
    UiFrameRunRequest,
    UiFrameRunResponse,
    UiRenderRequest,
    UiRenderResponse,
)
from interview_os.plugins import PluginDispatcher, PluginRegistry, load_plugin_dir

PLUGIN_DIR = Path(__file__).resolve().parents[4] / "plugins" / "postgres-interviewer"


def _load() -> None:
    PluginRegistry.reset()
    load_plugin_dir(PLUGIN_DIR, install_deps=False)


def test_manifest() -> None:
    _load()
    loaded = PluginRegistry().get("postgres-interviewer")
    assert loaded is not None
    manifest = loaded.manifest
    assert manifest.kind == "hook"
    assert manifest.applies_to is not None
    assert manifest.applies_to.skill_prefixes == ["sql"]
    assert [field.key for field in manifest.settings] == ["difficulty-bias"]
    assert [mode.id for mode in manifest.interview_modes] == ["pg-deep-dive"]
    assert [node.id for node in manifest.taxonomy] == ["sql.locking"]
    assert manifest.ui is not None
    assert "readiness.panels" in {str(slot) for slot in manifest.ui.slots}


def test_questions_suggest_biases_by_setting() -> None:
    _load()
    request = QuestionsSuggestRequest(skill_id="sql", round_type="technical", count=5)
    hard = asyncio.run(
        PluginDispatcher(settings_for=lambda _pid: {"difficulty-bias": "hard"}).questions_suggest(
            request
        )
    )
    assert hard
    first = cast(QuestionsSuggestResponse, hard[0]).questions[0]
    assert first.difficulty == "hard"

    easy = asyncio.run(
        PluginDispatcher(settings_for=lambda _pid: {"difficulty-bias": "easy"}).questions_suggest(
            request
        )
    )
    # No "easy" PostgreSQL questions exist, so the easy bias lands on medium first.
    assert cast(QuestionsSuggestResponse, easy[0]).questions[0].difficulty == "medium"


def test_ui_render_and_frame_run() -> None:
    _load()
    rendered = asyncio.run(
        PluginDispatcher().ui_render(UiRenderRequest(component="explain-analyze"))
    )
    assert cast(UiRenderResponse, rendered[0]).ui.type == "card"

    frame = asyncio.run(
        PluginDispatcher().ui_frame_run(
            UiFrameRunRequest(request={"skillId": "sql.indexing", "count": 1})
        )
    )
    questions = cast(UiFrameRunResponse, frame[0]).output["questions"]
    assert len(questions) == 1
    assert questions[0]["skillId"] == "sql.indexing"


def test_evaluation_review_observations() -> None:
    _load()
    question = EvaluationReviewQuestion(skill_id="sql", text="q", round_type="technical")
    evaluation = AnswerEvaluation.model_construct()
    no_answer = asyncio.run(
        PluginDispatcher().evaluation_review(
            EvaluationReviewRequest(question=question, answer=None, evaluation=evaluation)
        )
    )
    assert cast(EvaluationReviewResponse, no_answer[0]).observations[0].tone == "muted"

    with_answer = asyncio.run(
        PluginDispatcher().evaluation_review(
            EvaluationReviewRequest(
                question=question,
                answer=EvaluationReviewAnswer(text="I would check the index and query plan."),
                evaluation=evaluation,
            )
        )
    )
    assert cast(EvaluationReviewResponse, with_answer[0]).observations[0].tone == "green"
