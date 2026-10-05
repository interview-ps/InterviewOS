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
        resume_text=str(example["resumeText"]),
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
            kind="required",
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
