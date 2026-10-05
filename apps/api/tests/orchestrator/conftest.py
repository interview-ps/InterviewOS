"""Fixtures for the orchestrator service suites.

The services are driven directly (the `InterviewOrchestrator` facade is phase
5b) over a real `Store`, the `MockRuntime`, a real `SkillHost` with the built-in
skills registered, and a real `PackRegistry` over the bundled `packs/` dir.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from interview_os.ai.logger import NullLogger
from interview_os.ai.mock import MockRuntime
from interview_os.core import taxonomy
from interview_os.core.models import (
    CandidateProfile,
    CandidateSkill,
    Experience,
    Level,
    Project,
    Requirement,
    RequirementKind,
    TargetRole,
)
from interview_os.orchestrator.context import WorkflowContext
from interview_os.packs import PackDirs, PackRegistry
from interview_os.skills import SkillHost, register_builtin_skills, register_mock_handlers
from interview_os.store import Store

REPO_ROOT = Path(__file__).resolve().parents[4]
EXAMPLES_DIR = REPO_ROOT / "examples" / "backend-engineer"


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@pytest.fixture
def example() -> dict[str, str]:
    meta = json.loads((EXAMPLES_DIR / "meta.json").read_text(encoding="utf-8"))
    return {
        **meta,
        "resumeText": (EXAMPLES_DIR / "resume.md").read_text(encoding="utf-8"),
        "jobDescription": (EXAMPLES_DIR / "job.md").read_text(encoding="utf-8"),
    }


@pytest.fixture
def runtime() -> MockRuntime:
    mock = MockRuntime()
    register_mock_handlers(mock)
    return mock


@pytest.fixture
def host(runtime: MockRuntime) -> SkillHost:
    skill_host = SkillHost()
    register_builtin_skills(skill_host)
    return skill_host


@pytest.fixture
def packs(tmp_path: Path) -> PackRegistry:
    return PackRegistry(
        PackDirs(bundled=REPO_ROOT / "packs", installed=tmp_path / "installed-packs")
    )


@pytest.fixture
def ctx(
    file_store: Store, host: SkillHost, runtime: MockRuntime, packs: PackRegistry
) -> WorkflowContext:
    return WorkflowContext(
        store=file_store, host=host, runtime=runtime, logger=NullLogger(), packs=packs
    )


@pytest.fixture
def candidate(example: dict[str, str]) -> CandidateProfile:
    return CandidateProfile(
        id="cand_test",
        name="Ada Lovelace",
        headline="Senior backend engineer",
        experience=[
            Experience(
                title="Senior Backend Engineer",
                company="Acme",
                start="2021-01",
                end="2024-06",
                highlights=[
                    "Built the billing service in Go and PostgreSQL",
                    "Cut p99 latency by 40 percent on the payments API",
                ],
            )
        ],
        skills=[
            CandidateSkill(skill_id="sql", level=0.7, source="resume", evidence="PostgreSQL"),
            CandidateSkill(
                skill_id="distributed-systems", level=0.5, source="resume", evidence="Kafka"
            ),
        ],
        projects=[Project(name="Cache layer", description="Redis cache in front of the API")],
        achievements=["Led the migration to PostgreSQL 16"],
    )


@pytest.fixture
def target(example: dict[str, str]) -> TargetRole:
    return TargetRole(
        id="target_test",
        company=example["company"],
        role=example["role"],
        level=Level(example["level"]),
        job_description=example["jobDescription"],
        company_profile_id="generic",
        requirements=[
            Requirement(
                skill_id="sql",
                label="SQL",
                importance=0.9,
                kind=RequirementKind.REQUIRED,
                evidence="PostgreSQL",
            ),
            Requirement(
                skill_id="distributed-systems",
                label="Distributed systems",
                importance=0.8,
                kind=RequirementKind.REQUIRED,
                evidence="Kafka",
            ),
        ],
        preferred_skills=[
            Requirement(
                skill_id="apis",
                label="APIs",
                importance=0.6,
                kind=RequirementKind.PREFERRED,
                evidence="REST",
            )
        ],
    )


@pytest.fixture
def workspace(
    ctx: WorkflowContext, candidate: CandidateProfile, target: TargetRole, example: dict[str, str]
) -> tuple[CandidateProfile, TargetRole]:
    """Seed an active candidate + target row (the workspace service is phase 5b)."""

    now = iso_now()
    ctx.store.insert_candidate(
        id=candidate.id,
        active=1,
        name=candidate.name,
        headline=candidate.headline,
        resume_text=example["resumeText"],
        data=candidate,
        created_at=now,
    )
    ctx.store.insert_target(
        id=target.id,
        active=1,
        company=target.company,
        role=target.role,
        level=target.level.value,
        job_description=target.job_description,
        data=target,
        created_at=now,
    )
    return candidate, target


@pytest.fixture(autouse=True)
def _restore_taxonomy() -> Iterator[None]:
    """Role packs register taxonomy nodes globally; keep the suites isolated."""

    nodes = dict(taxonomy._nodes)
    children = {key: set(value) for key, value in taxonomy._children_index.items()}
    alias_index = taxonomy._alias_index
    yield
    taxonomy._nodes.clear()
    taxonomy._nodes.update(nodes)
    taxonomy._children_index.clear()
    taxonomy._children_index.update(children)
    taxonomy._alias_index = alias_index
