"""gap-analyzer — port of `apps/server/src/skills/analyze/gap-analyzer/`.

Deterministic — wraps `core.gaps`.
"""

from __future__ import annotations

from ...core.gaps import calculate_gaps
from ...core.models import (
    Gap,
    Level,
    Permission,
    Requirement,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
    SkillReadiness,
)
from ..framework import InterviewSkill, SkillContext, SkillInput

__all__ = ["GapAnalyzer", "GapAnalyzerInput", "gap_analyzer"]


class GapAnalyzerInput(SkillInput):
    requirements: list[Requirement]
    readiness: dict[str, SkillReadiness]
    level: Level


_MANIFEST = SkillManifest(
    id="gap-analyzer",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Deterministically diff target requirements against current readiness "
        "into a ranked gap list."
    ),
    inputs=[
        SkillManifestInput(key="requirements", permission=Permission.TARGET_READ),
        SkillManifestInput(key="readiness", permission=Permission.READINESS_READ),
        SkillManifestInput(key="level", permission=Permission.TARGET_READ),
    ],
    outputs=["gaps"],
    permissions=[Permission.TARGET_READ, Permission.READINESS_READ],
)


class GapAnalyzer(InterviewSkill[GapAnalyzerInput, list[Gap]]):
    id = "gap-analyzer"
    manifest = _MANIFEST
    input_schema = GapAnalyzerInput
    output_schema = None

    async def execute(self, input: GapAnalyzerInput, ctx: SkillContext) -> list[Gap]:
        return calculate_gaps(
            requirements=input.requirements,
            readiness=input.readiness,
            level=input.level,
        )


gap_analyzer = GapAnalyzer()
