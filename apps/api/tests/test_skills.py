"""Skill layer: SkillHost gating and the analyze skills on the mock runtime."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from interview_os.ai.mock import MockRuntime
from interview_os.core.models import (
    CandidateProfile,
    CompanyNotesProfile,
    Level,
    Permission,
    ReadinessStatus,
    Requirement,
    RequirementKind,
    SkillKind,
    SkillManifest,
    SkillReadiness,
)
from interview_os.skills import (
    PermissionError,
    SkillContext,
    SkillHost,
    register_builtin_skills,
    register_mock_handlers,
    taxonomy_entries,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE_DIR = REPO_ROOT / "examples" / "backend-engineer"


@pytest.fixture
def example() -> dict[str, object]:
    meta = json.loads((EXAMPLE_DIR / "meta.json").read_text(encoding="utf-8"))
    return {
        **meta,
        "resumeText": (EXAMPLE_DIR / "resume.md").read_text(encoding="utf-8"),
        "jobDescription": (EXAMPLE_DIR / "job.md").read_text(encoding="utf-8"),
    }


@pytest.fixture
def runtime() -> MockRuntime:
    rt = MockRuntime()
    register_mock_handlers(rt)
    return rt


@pytest.fixture
def host(runtime: MockRuntime) -> SkillHost:
    skill_host = SkillHost()
    register_builtin_skills(skill_host)
    return skill_host


def _ctx(runtime: MockRuntime) -> SkillContext:
    return SkillContext(runtime=runtime)


async def test_resume_analyzer_extracts_profile(
    host: SkillHost, runtime: MockRuntime, example: dict[str, object]
) -> None:
    output = await host.invoke(
        "resume-analyzer",
        {"resumeText": example["resumeText"], "taxonomy": taxonomy_entries()},
        _ctx(runtime),
    )
    assert output.skills, "mock must match at least one skill from the example resume"
    assert all(skill.source == "resume" for skill in output.skills)
    assert all(0.0 <= skill.level <= 1.0 for skill in output.skills)
    assert isinstance(output.name, str)
    CandidateProfile(
        id="cand_test",
        skills=output.skills,
        experience=output.experience,
        projects=output.projects,
        education=output.education,
    )


async def test_jd_analyzer_splits_required_and_preferred(
    host: SkillHost, runtime: MockRuntime, example: dict[str, object]
) -> None:
    output = await host.invoke(
        "jd-analyzer",
        {
            "jobDescription": example["jobDescription"],
            "company": example["company"],
            "role": example["role"],
            "level": example["level"],
            "taxonomy": taxonomy_entries(),
        },
        _ctx(runtime),
    )
    assert output.requirements
    assert all(r.kind == "required" for r in output.requirements)
    assert all(r.kind == "preferred" for r in output.preferred_skills)
    required = {r.skill_id for r in output.requirements}
    assert not (required & {r.skill_id for r in output.preferred_skills})


async def test_gap_analyzer_is_deterministic(host: SkillHost, runtime: MockRuntime) -> None:
    requirements = [
        Requirement(
            skill_id="distributed-systems.caching",
            label="Caching",
            importance=0.8,
            kind=RequirementKind.REQUIRED,
            evidence="cache",
        )
    ]
    readiness = {
        "distributed-systems.caching": SkillReadiness(
            skill_id="distributed-systems.caching",
            label="Caching",
            score=0.4,
            confidence=0.5,
            status=ReadinessStatus.WEAK,
        )
    }
    first = await host.invoke(
        "gap-analyzer",
        {"requirements": requirements, "readiness": readiness, "level": Level.SENIOR},
        _ctx(runtime),
    )
    second = await host.invoke(
        "gap-analyzer",
        {"requirements": requirements, "readiness": readiness, "level": Level.SENIOR},
        _ctx(runtime),
    )
    assert [gap.model_dump() for gap in first] == [gap.model_dump() for gap in second]
    assert first[0].gap == pytest.approx(0.4)


async def test_company_profiler_marks_themes(host: SkillHost, runtime: MockRuntime) -> None:
    notes = (
        "# Values\n"
        "- We care about ownership and customer focus\n"
        "- We value learning\n"
        "Our interview loop has a system design round."
    )
    output = await host.invoke(
        "company-profiler",
        {"company": "Acme", "companyNotes": notes, "taxonomy": taxonomy_entries()},
        _ctx(runtime),
    )
    CompanyNotesProfile.model_validate(output.model_dump())
    assert "ownership" in output.behavioral_themes
    assert "customer focus" in output.behavioral_themes
    assert output.values


async def test_host_rejects_undeclared_input_keys(host: SkillHost, runtime: MockRuntime) -> None:
    with pytest.raises(PermissionError, match="does not declare input"):
        await host.invoke(
            "gap-analyzer",
            {"requirements": [], "readiness": {}, "level": "mid", "sneaky": True},
            _ctx(runtime),
        )


async def test_host_write_gate(host: SkillHost) -> None:
    host.assert_can("resume-analyzer", "candidate.write")
    with pytest.raises(PermissionError, match="not allowed"):
        host.assert_can("gap-analyzer", "candidate.write")


async def test_unknown_skill_is_not_found(host: SkillHost, runtime: MockRuntime) -> None:
    from interview_os.core.models import AppError

    with pytest.raises(AppError) as err:
        await host.invoke("nope", {}, _ctx(runtime))
    assert err.value.code == "NOT_FOUND"


async def test_runtime_is_gated_behind_runtime_invoke(runtime: MockRuntime) -> None:
    host = SkillHost()
    register_builtin_skills(host)
    probe_manifest = SkillManifest(
        id="probe",
        version="1.0.0",
        kind=SkillKind.BUILTIN,
        permissions=[Permission.CANDIDATE_READ],
    )
    assert Permission.RUNTIME_INVOKE not in probe_manifest.permissions

    class _Probe:
        id = "probe"
        manifest = probe_manifest
        input_schema = None
        output_schema = None

        async def execute(self, input: object, ctx: SkillContext) -> object:
            return {"kind": ctx.runtime.kind}

    host.register(_Probe())  # type: ignore[arg-type]
    with pytest.raises(PermissionError, match="cannot use the runtime"):
        await host.invoke("probe", {}, _ctx(runtime))


async def test_interviewer_asks_a_question(host: SkillHost, runtime: MockRuntime) -> None:
    output = await host.invoke(
        "interviewer",
        {
            "skillId": "distributed-systems.caching",
            "label": "Caching",
            "role": "Senior Backend Engineer",
            "level": "senior",
            "company": "Northwind Cloud",
            "reason": "weak area",
            "previousQuestions": ["What is a cache?"],
            "candidateSummary": "Backend engineer with 6 years.",
            "roundType": "mixed",
        },
        _ctx(runtime),
    )
    assert output.question
    assert output.topic
    assert output.difficulty in ("easy", "medium", "hard")
    assert output.expected_concepts


async def test_answer_evaluator_normalizes_and_scores(
    host: SkillHost, runtime: MockRuntime
) -> None:
    output = await host.invoke(
        "answer-evaluator",
        {
            "question": {
                "text": "How would you keep cache entries consistent?",
                "topic": "Cache consistency",
                "skillId": "distributed-systems.caching",
                "expectedConcepts": [
                    {
                        "concept": "TTL",
                        "skillId": "distributed-systems.caching",
                        "keywords": ["ttl"],
                    }
                ],
                "difficulty": "medium",
            },
            "answer": "I would use a TTL with explicit invalidation on writes.",
            "role": "Senior Backend Engineer",
            "level": "senior",
            "roundType": "mixed",
        },
        _ctx(runtime),
    )
    assert output.summary
    assert output.scores
    assert all(0.0 <= score.score <= 1.0 for score in output.scores)
    assert all(0.0 <= score.confidence <= 1.0 for score in output.scores)


async def test_debriefs_on_the_mock_runtime(host: SkillHost, runtime: MockRuntime) -> None:
    debrief = await host.invoke(
        "interview-debrief",
        {
            "role": "Senior Backend Engineer",
            "questions": [{"text": "Q1", "skillId": "python", "topic": "Python"}],
            "evaluations": [
                {
                    "summary": "ok",
                    "strengths": [{"skill": "python", "evidence": "clear"}],
                    "weaknesses": [{"skill": "sql", "severity": "high", "evidence": "thin"}],
                }
            ],
            "openActions": [{"skillId": "sql", "action": "Practice SQL joins"}],
        },
        _ctx(runtime),
    )
    assert "Mock interview" in debrief.summary
    assert debrief.went_well
    assert debrief.next_actions == ["Practice SQL joins"]

    loop = await host.invoke(
        "loop-debrief",
        {
            "role": "Senior Backend Engineer",
            "company": "Northwind Cloud",
            "rounds": [
                {
                    "mode": "technical",
                    "label": "Technical",
                    "summaries": ["Solid fundamentals."],
                    "rubricAverages": {"correctness": 0.8, "reasoning": 0.7},
                    "handoff": None,
                },
                {
                    "mode": "hr",
                    "label": "HR",
                    "summaries": [],
                    "rubricAverages": {"communication": 0.3},
                    "handoff": {
                        "weakSkills": [
                            {
                                "skillId": "communication",
                                "score": 0.3,
                                "observation": "rambling",
                            }
                        ],
                        "strongSkills": [],
                        "observations": [],
                    },
                },
            ],
            "readinessChange": {"before": 0.4, "after": 0.55},
        },
        _ctx(runtime),
    )
    assert loop.rounds[0].signal == "strong"
    assert loop.rounds[1].signal == "weak"
    assert loop.readiness_change.after == pytest.approx(0.55)
    assert any("Communication" in action for action in loop.top_actions)


async def test_interview_planner_selects_through_the_host(
    host: SkillHost, runtime: MockRuntime
) -> None:
    output = await host.invoke(
        "interview-planner",
        {
            "requirements": [
                {
                    "skillId": "python",
                    "label": "Python",
                    "importance": 0.9,
                    "kind": "required",
                    "evidence": "python",
                }
            ],
            "readiness": {},
            "evidence": [],
            "askedThisSession": [],
            "askedPreviousSession": [],
            "questionIndex": 0,
        },
        _ctx(runtime),
    )
    assert output is not None
    assert output.skill_id == "python"
    assert output.candidates


async def test_prep_planner_actions(host: SkillHost, runtime: MockRuntime) -> None:
    output = await host.invoke(
        "prep-planner",
        {
            "targets": [
                {
                    "skillId": "distributed-systems.caching",
                    "label": "Caching",
                    "reason": "weak in the last session",
                    "missingConcepts": ["TTL"],
                    "severity": "high",
                }
            ],
            "role": "Senior Backend Engineer",
            "level": "senior",
        },
        _ctx(runtime),
    )
    assert output.actions
    assert output.actions[0].skill_id == "distributed-systems.caching"
    assert 2 <= len(output.actions[0].success_criteria) <= 4


async def test_star_coach_generate_and_review(host: SkillHost, runtime: MockRuntime) -> None:
    generated = await host.invoke(
        "star-coach",
        {
            "mode": "generate",
            "experience": [
                {
                    "title": "Senior Backend Engineer",
                    "company": "Northwind Cloud",
                    "highlights": ["led the caching migration"],
                }
            ],
            "achievements": [],
            "projects": [],
            "behavioralSkillIds": ["behavioral.leadership"],
            "existingTitles": [],
        },
        _ctx(runtime),
    )
    assert generated.stories
    story = generated.stories[0]
    assert story.title.startswith("Northwind Cloud:")
    assert story.result == "[add metric]"
    assert story.skill_ids == ["behavioral.leadership"]

    review = await host.invoke(
        "star-coach",
        {
            "mode": "review",
            "story": {
                "title": "Caching migration",
                "situation": "At Northwind Cloud our cache was stale.",
                "task": "I owned the migration.",
                "action": "I led the migration.",
                "result": "[add metric]",
            },
            "role": "Senior Backend Engineer",
            "level": "senior",
        },
        _ctx(runtime),
    )
    assert review.feedback
    assert any("Result" in item for item in review.missing)
    assert review.improved_draft.result.startswith("[add metric")


async def test_resume_coach_bullets_and_tailor(host: SkillHost, runtime: MockRuntime) -> None:
    bullets = await host.invoke(
        "resume-coach",
        {
            "mode": "bullets",
            "resumeText": "Led the caching migration at Northwind Cloud.",
            "bullets": ["responsible for the caching layer"],
        },
        _ctx(runtime),
    )
    assert bullets.suggestions
    assert bullets.suggestions[0].original == "responsible for the caching layer"
    assert bullets.suggestions[0].improved.startswith("Delivered")

    tailoring = await host.invoke(
        "resume-coach",
        {
            "mode": "tailor",
            "resumeText": "Led the caching migration at Northwind Cloud.",
            "requirements": [
                {
                    "skillId": "distributed-systems.caching",
                    "label": "Caching",
                    "importance": 0.8,
                    "kind": "required",
                    "evidence": "cache",
                },
                {
                    "skillId": "infrastructure.kubernetes",
                    "label": "Kubernetes",
                    "importance": 0.6,
                    "kind": "required",
                    "evidence": "k8s",
                },
            ],
            "role": "Senior Backend Engineer",
            "level": "senior",
        },
        _ctx(runtime),
    )
    assert "Caching" in tailoring.emphasize
    assert "Kubernetes" in tailoring.prep_gaps
    covered = next(a for a in tailoring.alignment if a.requirement == "Caching")
    assert covered.resume_evidence is not None
    gap = next(a for a in tailoring.alignment if a.requirement == "Kubernetes")
    assert gap.resume_evidence is None


@pytest.mark.parametrize("mode", ["mixed", "system_design", "coding"])
def test_answer_evaluator_schema_is_provider_strict(mode: str) -> None:
    """OpenAI/Codex require `properties` on every object schema.

    The AI-facing evaluator schema must be fully typed — no free-form records
    (`modeSignals`) or untyped arrays (`designUpdates`). Regression for the
    `answer-evaluator.*` Codex 400 ("...properties is required for object
    schemas").
    """

    from interview_os.ai.structured import to_strict_json_schema
    from interview_os.skills.evaluate.answer_evaluator import rubric_schema_for

    schema = to_strict_json_schema(rubric_schema_for(mode))

    def walk(node: object) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "object":
            assert "properties" in node, f"{mode}: object without properties"
            assert node.get("additionalProperties") is False
        if node.get("type") == "array":
            assert node.get("items") != {}, f"{mode}: array with untyped items"
        for child in node.values():
            if isinstance(child, list):
                for item in child:
                    walk(item)
            else:
                walk(child)

    walk(schema)


def test_mode_signals_ai_round_trips_to_the_open_record() -> None:
    """The typed AI shape must serialise back to the record `mode.reduce` reads."""

    from interview_os.core.models import DesignUpdate, DesignUpdateStatus
    from interview_os.skills.evaluate.answer_evaluator import ModeSignalsAi

    signals = ModeSignalsAi(
        design_updates=[
            DesignUpdate(
                dimension="apis",
                status=DesignUpdateStatus.PARTIAL,
                notes="surface sketched",
            )
        ]
    )
    assert signals.model_dump(mode="json", by_alias=True, exclude_none=True) == {
        "designUpdates": [
            {"dimension": "apis", "status": "partial", "notes": "surface sketched"}
        ]
    }
    assert ModeSignalsAi().model_dump(mode="json", by_alias=True, exclude_none=True) == {}
