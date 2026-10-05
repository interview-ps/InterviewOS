"""ExportService: bundle shape, validation, replace-import round-trip."""

from __future__ import annotations

from pathlib import Path

import pytest

from interview_os.ai.logger import NullLogger
from interview_os.core.models import (
    EXPORT_PARTS,
    INTERVIEW_OS_VERSION,
    AppError,
    CandidateProfile,
    ExternalContextRow,
    InterviewPack,
    InterviewPackRound,
    TargetRole,
)
from interview_os.orchestrator.context import WorkflowContext
from interview_os.orchestrator.services.export import ExportService
from interview_os.skills import SkillHost
from interview_os.store import open_store

from .conftest import iso_now


def _service(ctx: WorkflowContext) -> ExportService:
    return ExportService(ctx)


async def _snapshot(service: ExportService) -> dict[str, object]:
    bundle = await service.export_state()
    data = bundle.model_dump(by_alias=True, mode="json")
    data["exportedAt"] = "<ts>"
    return data


async def _populate(ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]) -> None:
    store = ctx.store
    now = iso_now()
    store.insert_evidence(
        id="ev_1",
        candidate_id="cand_test",
        skill_id="sql",
        type="interview_answer",
        score=0.4,
        confidence=0.5,
        observation="weak",
        created_at=now,
    )
    store.append_readiness_snapshot(
        skill_id="sql",
        score=0.4,
        confidence=0.5,
        evidence_ids=["ev_1"],
        reason="interview",
        computed_at=now,
    )
    store.insert_loop(
        id="loop_1",
        target_id="target_test",
        rounds=[{"mode": "technical", "label": "Tech", "plannedQuestions": 2}],
        status="in_progress",
        created_at=now,
    )
    store.insert_session(
        id="sess_1",
        candidate_id="cand_test",
        target_id="target_test",
        status="question",
        round_type="technical",
        loop_id="loop_1",
        loop_round=1,
        created_at=now,
    )
    store.insert_question(
        id="q_1", session_id="sess_1", skill_id="sql", text="Explain indexes.", created_at=now
    )
    store.insert_answer(
        id="ans_1", question_id="q_1", session_id="sess_1", text="Use a B-tree.", created_at=now
    )
    store.insert_debrief(id="deb_1", session_id="sess_1", data={"summary": "Solid"}, created_at=now)
    store.insert_action(
        id="act_1",
        skill_id="sql",
        target_id="target_test",
        priority=1.0,
        action="Practice indexes",
        source_evidence_ids=["ev_1"],
        created_at=now,
    )
    store.insert_story(
        id="story_1",
        candidate_id="cand_test",
        title="Billing migration",
        updated_at=now,
        situation="Legacy billing",
        task="Migrate",
        action="Led the work",
        result="Cut costs",
        skill_ids=["sql"],
        source="user",
    )
    store.insert_resume_review(
        id="rev_1",
        candidate_id="cand_test",
        target_id="target_test",
        ats={"score": 70},
        suggestions=[],
        tailoring=None,
        linked_gap_skill_ids=["sql"],
        guard={"substitutions": 0, "dropped": 0},
        created_at=now,
    )
    store.insert_interview_pack(
        id="user-pack",
        data=InterviewPack(
            id="user-pack",
            name="User pack",
            version="1.0.0",
            skills=["sql"],
            rounds=[
                InterviewPackRound(mode="technical", label="Tech", planned_questions=2),
                InterviewPackRound(mode="behavioral", label="Behav", planned_questions=2),
            ],
            duration_minutes=60,
        ),
        source="user",
        created_at=now,
        updated_at=now,
    )
    store.insert_user_question(
        id="uq_1", skill_id="sql", text="Explain a covering index.", created_at=now
    )
    store.insert_external_context(
        ExternalContextRow(
            id="ctx_1",
            server_id="fake",
            tool="get_repository",
            title="repo",
            text="readme text",
            created_at=now,
        )
    )
    store.set_setting("questionSources", '{"companyPacks":true}')
    store.set_setting("runtimeKind", "mock")
    store.insert_usage_event(id="evt_1", event="history.viewed", created_at=now)


async def test_export_shape_and_filtered_settings(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    await _populate(ctx, workspace)
    bundle = await _service(ctx).export_state()

    assert bundle.format == "interview-os.export"
    assert bundle.version == 1
    assert bundle.app_version == INTERVIEW_OS_VERSION
    assert [row.id for row in bundle.candidate.profiles] == ["cand_test"]
    assert [row.id for row in bundle.targets] == ["target_test"]
    assert [row.id for row in bundle.evidence] == ["ev_1"]
    assert [row.id for row in bundle.readiness.snapshots] == [1]
    assert [row.id for row in bundle.interviews.sessions] == ["sess_1"]
    assert [row.id for row in bundle.interviews.loops] == ["loop_1"]
    assert [row.id for row in bundle.interviews.questions] == ["q_1"]
    assert [row.id for row in bundle.interviews.answers] == ["ans_1"]
    assert [row.id for row in bundle.interviews.debriefs] == ["deb_1"]
    assert [row.id for row in bundle.preparation.actions] == ["act_1"]
    assert [row.id for row in bundle.stories] == ["story_1"]
    assert [row.id for row in bundle.resume_reviews] == ["rev_1"]
    assert [row.id for row in bundle.interview_packs] == ["user-pack"]
    assert [row.id for row in bundle.question_bank] == ["uq_1"]
    assert [row.id for row in bundle.external_contexts] == ["ctx_1"]
    assert bundle.settings == {"questionSources": '{"companyPacks":true}'}

    keys = set(bundle.model_dump(by_alias=True))
    for banned in (
        "runtimeSessions",
        "pluginInstalls",
        "mcpServers",
        "usageEvents",
        "runtime_sessions",
        "plugin_installs",
        "mcp_servers",
        "usage_events",
    ):
        assert banned not in keys
    assert "settings" in keys


async def test_export_state_part(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    await _populate(ctx, workspace)
    service = _service(ctx)

    for part in EXPORT_PARTS:
        assert await service.export_state_part(part) is not None
    candidate_part = await service.export_state_part("candidate")
    assert len(candidate_part.profiles) == 1  # type: ignore[attr-defined]

    with pytest.raises(AppError) as error:
        await service.export_state_part("nope")
    assert error.value.code == "NOT_FOUND"
    assert error.value.args[0] == 'no export part "nope"'


async def test_roundtrip_into_a_second_store(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole], tmp_path: Path
) -> None:
    await _populate(ctx, workspace)
    exporter = _service(ctx)
    bundle = await exporter.export_state()

    second = open_store(tmp_path / "second.db")
    try:
        target_ctx = WorkflowContext(
            store=second,
            host=SkillHost(),
            runtime=ctx.runtime,
            logger=NullLogger(),
            packs=ctx.packs,
        )
        importer = _service(target_ctx)
        appended: list[str] = []

        async def recompute_after_import() -> object:
            appended.append("import")
            second.append_readiness_snapshot(
                skill_id="sql",
                score=0.4,
                confidence=0.5,
                evidence_ids=["ev_1"],
                reason="import",
                computed_at=iso_now(),
            )
            return None

        importer.recompute_after_import = recompute_after_import
        counts = await importer.import_state(bundle.model_dump(by_alias=True), mode="replace")

        assert counts["candidate.profiles"] == 1
        assert counts["interviews.sessions"] == 1
        assert counts["interviews.questions"] == 1
        assert counts["interviews.answers"] == 1
        assert counts["interviews.loops"] == 1
        assert counts["interviews.debriefs"] == 1
        assert counts["evidence"] == 1
        assert counts["readiness.snapshots"] == 1
        assert counts["preparation.actions"] == 1
        assert counts["stories"] == 1
        assert counts["resumeReviews"] == 1
        assert counts["interviewPacks"] == 1
        assert counts["questionBank"] == 1
        assert counts["externalContexts"] == 1
        assert counts["settings"] == 1
        assert appended == ["import"]

        assert [row.id for row in second.list_candidates()] == ["cand_test"]
        assert second.get_session("sess_1") is not None
        assert second.get_loop("loop_1") is not None
        assert second.get_debrief("sess_1") is not None
        assert [row.id for row in second.list_questions("sess_1")] == ["q_1"]
        assert second.get_setting("questionSources") == '{"companyPacks":true}'
        assert second.get_setting("runtimeKind") is None
        assert second.count_usage_events("history.viewed") == 0
        snapshots = second.list_all_readiness()
        assert [snapshot.reason for snapshot in snapshots] == ["interview", "import"]
        assert snapshots[0].evidence_ids == ["ev_1"]

        re_export = (await importer.export_state()).model_dump(by_alias=True)
        original = bundle.model_dump(by_alias=True)
        re_export["exportedAt"] = original["exportedAt"]
        re_export["readiness"]["snapshots"] = [
            snapshot
            for snapshot in re_export["readiness"]["snapshots"]
            if snapshot["reason"] != "import"
        ]
        assert re_export == original
    finally:
        second.close()


async def test_invalid_bundle_and_unsupported_mode_leave_state_untouched(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    await _populate(ctx, workspace)
    service = _service(ctx)
    before = await _snapshot(service)

    with pytest.raises(AppError) as invalid:
        await service.import_state({"format": "nope"}, mode="replace")
    assert invalid.value.code == "VALIDATION"
    assert str(invalid.value.args[0]).startswith("invalid export bundle: ")

    with pytest.raises(AppError) as mode_error:
        await service.import_state({}, mode="merge")
    assert mode_error.value.code == "VALIDATION"
    assert mode_error.value.args[0] == 'unsupported import mode "merge"'

    assert await _snapshot(service) == before


async def test_dangling_references_are_rejected_before_any_write(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    await _populate(ctx, workspace)
    service = _service(ctx)
    bundle = (await service.export_state()).model_dump(by_alias=True)
    bundle["interviews"]["questions"][0]["sessionId"] = "ghost"
    before = await _snapshot(service)

    with pytest.raises(AppError) as error:
        await service.import_state(bundle, mode="replace")
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == "question q_1 references missing session ghost"
    assert await _snapshot(service) == before

    bundle["interviews"]["questions"][0]["sessionId"] = "sess_1"
    bundle["interviews"]["answers"][0]["questionId"] = "ghost"
    with pytest.raises(AppError) as answer_error:
        await service.import_state(bundle, mode="replace")
    assert answer_error.value.args[0] == "answer ans_1 references missing question ghost"

    bundle["interviews"]["answers"][0]["questionId"] = "q_1"
    bundle["evidence"][0]["candidateId"] = "ghost"
    with pytest.raises(AppError) as evidence_error:
        await service.import_state(bundle, mode="replace")
    assert evidence_error.value.args[0] == "evidence ev_1 references missing candidate ghost"


async def test_duplicate_ids_are_rejected(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    await _populate(ctx, workspace)
    service = _service(ctx)
    bundle = (await service.export_state()).model_dump(by_alias=True)
    bundle["candidate"]["profiles"].append(bundle["candidate"]["profiles"][0])

    with pytest.raises(AppError) as error:
        await service.import_state(bundle, mode="replace")
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == 'duplicate id "cand_test" in candidate.profiles'


async def test_import_rolls_back_when_an_insert_fails(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    await _populate(ctx, workspace)
    service = _service(ctx)
    bundle = (await service.export_state()).model_dump(by_alias=True)
    bundle["candidate"]["profiles"][0]["data"] = object()
    before = await _snapshot(service)

    with pytest.raises(TypeError):
        await service.import_state(bundle, mode="replace")
    assert await _snapshot(service) == before


async def test_import_rejects_malformed_rows(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    await _populate(ctx, workspace)
    service = _service(ctx)
    bundle = (await service.export_state()).model_dump(by_alias=True)
    bundle["stories"].append({"id": "story_bad"})

    with pytest.raises(AppError) as error:
        await service.import_state(bundle, mode="replace")
    assert error.value.code == "VALIDATION"
    assert str(error.value.args[0]) == (
        "invalid export bundle: stories.1.candidateId Field required"
    )
    assert len(ctx.store.list_all_stories()) == 1
