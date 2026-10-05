"""Pack models — port of `packs/index.ts` (company, role and interview packs)."""

from __future__ import annotations

from collections.abc import Sequence
from enum import StrEnum
from typing import Annotated, Literal, Protocol

from pydantic import AfterValidator, Field, StringConstraints, model_validator

from ..skill_id import SkillId
from .companies import CompanyEmphasis
from .interview import ModeId, QuestionDifficulty
from .platform import is_valid_version
from .preparation import HttpsUrl, PrepResourceKind
from .shared import CamelModel, SlugId

__all__ = [
    "CompanyPack",
    "CompanyPackBehavioralFramework",
    "CompanyPackOverlay",
    "CompanyPackOverlayAppliesTo",
    "CompanyPackStage",
    "CompanyPackWithOverlays",
    "InterviewPack",
    "InterviewPackRound",
    "PackItem",
    "PackQuestion",
    "PackResource",
    "PackSource",
    "PackVersion",
    "Provenance",
    "QuestionCandidate",
    "QuestionSource",
    "QuestionSourceKind",
    "RolePack",
    "RolePackDimension",
    "RolePackRubric",
    "RolePackTaxonomyNode",
    "check_overlay_provenance",
]

_SHORT_TEXT = Annotated[str, StringConstraints(min_length=1, max_length=120)]
_QUESTION_TEXT = Annotated[str, StringConstraints(min_length=1, max_length=80)]


def _valid_pack_version(value: str) -> str:
    if not is_valid_version(value):
        raise ValueError("version must be semver x.y.z")
    return value


PackVersion = Annotated[
    str,
    StringConstraints(min_length=1, max_length=32),
    AfterValidator(_valid_pack_version),
]


class Provenance(StrEnum):
    """Whether an item is backed by a declared source or community observation."""

    SOURCED = "sourced"
    COMMUNITY = "community"


class PackSource(CamelModel):
    id: SlugId
    title: str = Field(min_length=1, max_length=200)
    url: HttpsUrl | None = None


class _Provenanced(Protocol):
    provenance: Provenance
    source: SlugId | None


def _check_sourced_items(
    items: Sequence[_Provenanced], source_ids: set[str], where: str
) -> str | None:
    """Every "sourced" item must name a declared source id."""

    for index, item in enumerate(items):
        if item.provenance != Provenance.SOURCED:
            continue
        if item.source is None:
            return f"{where}.{index}.source: sourced items must reference a declared source id"
        if item.source not in source_ids:
            return f'{where}.{index}.source: source "{item.source}" is not declared in the pack'
    return None


class PackItem(CamelModel):
    """A fact-like pack item — must clearly mark sourced vs community material."""

    text: str = Field(min_length=1, max_length=2000)
    provenance: Provenance
    # required when provenance is "sourced"; must match a sources[].id.
    source: SlugId | None = None


class PackQuestion(CamelModel):
    skill_id: SkillId
    text: str = Field(min_length=10, max_length=1200)
    difficulty: QuestionDifficulty | None = None
    mode: ModeId | None = None
    provenance: Provenance
    source: SlugId | None = None


class CompanyPackStage(CamelModel):
    mode: ModeId
    label: str = Field(min_length=1, max_length=80)
    planned_questions: int = Field(ge=1, le=6)
    provenance: Provenance
    source: SlugId | None = None


class CompanyPackBehavioralFramework(CamelModel):
    name: str = Field(min_length=1, max_length=120)
    themes: list[_SHORT_TEXT] = Field(default_factory=list)
    guidance: str = Field(default="", max_length=1500)


class CompanyPackOverlayAppliesTo(CamelModel):
    role_keywords: list[_QUESTION_TEXT] = Field(default_factory=list)
    mode: ModeId | None = None


class CompanyPack(CamelModel):
    format: str = "interview-os.company-pack"
    id: SlugId
    name: str = Field(min_length=1, max_length=120)
    version: PackVersion
    description: str = Field(default="", max_length=2000)
    maintainers: list[_SHORT_TEXT] = Field(default_factory=list)
    aliases: list[_SHORT_TEXT] = Field(default_factory=list)
    sources: list[PackSource] = Field(default_factory=list)
    stages: list[CompanyPackStage] = Field(min_length=2, max_length=7)
    competencies: list[PackItem] = Field(default_factory=list)
    emphasis: list[CompanyEmphasis] = Field(default_factory=list)
    behavioral_framework: CompanyPackBehavioralFramework
    follow_up_depth: Literal[1, 2, 3] = 2
    question_style: list[PackItem] = Field(default_factory=list)
    evaluation_guidance: list[PackItem] = Field(default_factory=list)
    role_expectations: dict[str, list[Annotated[str, StringConstraints(max_length=300)]]] = Field(
        default_factory=dict
    )
    questions: list[PackQuestion] = Field(default_factory=list)

    @model_validator(mode="after")
    def _sourced_items_cite_sources(self) -> CompanyPack:
        source_ids = {source.id for source in self.sources}
        for where, items in (
            ("stages", list(self.stages)),
            ("competencies", list(self.competencies)),
            ("questionStyle", list(self.question_style)),
            ("evaluationGuidance", list(self.evaluation_guidance)),
            ("questions", list(self.questions)),
        ):
            error = _check_sourced_items(items, source_ids, where)
            if error is not None:
                raise ValueError(error)
        return self


class CompanyPackOverlay(CamelModel):
    """Extra YAML files in a company pack directory are overlays."""

    applies_to: CompanyPackOverlayAppliesTo = Field(
        default_factory=lambda: CompanyPackOverlayAppliesTo(role_keywords=[])
    )
    competencies: list[PackItem] = Field(default_factory=list)
    question_style: list[PackItem] = Field(default_factory=list)
    evaluation_guidance: list[PackItem] = Field(default_factory=list)
    stages: list[CompanyPackStage] | None = Field(default=None, min_length=2, max_length=7)
    questions: list[PackQuestion] = Field(default_factory=list)


class CompanyPackWithOverlays(CompanyPack):
    """A company pack plus the overlay files found next to it."""

    overlays: list[CompanyPackOverlay] = Field(default_factory=list)


def check_overlay_provenance(
    overlay_id: str, overlay: CompanyPackOverlay, sources: Sequence[PackSource]
) -> None:
    """Validate overlay items against the parent pack's declared sources."""

    source_ids = {source.id for source in sources}
    items: list[_Provenanced] = [
        *overlay.competencies,
        *overlay.question_style,
        *overlay.evaluation_guidance,
        *(overlay.stages or []),
        *overlay.questions,
    ]
    if _check_sourced_items(items, source_ids, f'overlay "{overlay_id}"') is not None:
        raise ValueError(
            f'overlay "{overlay_id}" has a sourced item without a declared pack source'
        )


# ------------------------------------------------------------------ role pack


class PackResource(CamelModel):
    """A role-pack resource entry — the pack id is stamped at load time."""

    skill_id: SkillId
    title: str = Field(min_length=1, max_length=200)
    url: HttpsUrl | None = None
    summary: str | None = Field(default=None, max_length=600)
    kind: PrepResourceKind


class RolePackTaxonomyNode(CamelModel):
    id: SkillId
    label: str = Field(min_length=1, max_length=120)
    keywords: list[_QUESTION_TEXT] = Field(default_factory=list)


class RolePackDimension(CamelModel):
    skill_id: SkillId
    weight: float = Field(ge=0, le=1)


class RolePackRubric(CamelModel):
    skill_id: SkillId | None = None
    mode: ModeId | None = None
    criteria: list[Annotated[str, StringConstraints(min_length=1, max_length=300)]] = Field(
        min_length=1, max_length=8
    )

    @model_validator(mode="after")
    def _needs_skill_or_mode(self) -> RolePackRubric:
        if self.skill_id is None and self.mode is None:
            raise ValueError("a rubric needs a skillId or a mode")
        return self


class RolePack(CamelModel):
    format: str = "interview-os.role-pack"
    id: SlugId
    name: str = Field(min_length=1, max_length=120)
    version: PackVersion
    description: str = Field(default="", max_length=2000)
    maintainers: list[_SHORT_TEXT] = Field(default_factory=list)
    sources: list[PackSource] = Field(default_factory=list)
    taxonomy: list[RolePackTaxonomyNode] = Field(default_factory=list)
    dimensions: list[RolePackDimension] = Field(min_length=1, max_length=30)
    default_question_categories: list[ModeId] = Field(min_length=2, max_length=7)
    rubrics: list[RolePackRubric] = Field(default_factory=list)
    resources: list[PackResource] = Field(default_factory=list)
    questions: list[PackQuestion] = Field(default_factory=list)

    @model_validator(mode="after")
    def _sourced_items_cite_sources(self) -> RolePack:
        error = _check_sourced_items(
            list(self.questions), {source.id for source in self.sources}, "questions"
        )
        if error is not None:
            raise ValueError(error)
        return self


# ------------------------------------------------------------ interview pack


class InterviewPackRound(CamelModel):
    mode: ModeId
    label: str = Field(min_length=1, max_length=80)
    planned_questions: int = Field(ge=1, le=6)


class InterviewPack(CamelModel):
    format: str = "interview-os.interview-pack"
    id: SlugId
    name: str = Field(min_length=1, max_length=120)
    version: PackVersion
    description: str = Field(default="", max_length=2000)
    author: str = Field(default="", max_length=120)
    skills: list[SkillId] = Field(min_length=1, max_length=12)
    rounds: list[InterviewPackRound] = Field(min_length=2, max_length=7)
    duration_minutes: int = Field(ge=15, le=600)


# ----------------------------------------------------------- question sources


class QuestionSourceKind(StrEnum):
    COMPANY_PACK = "company_pack"
    ROLE_PACK = "role_pack"
    USER_BANK = "user_bank"
    PLUGIN = "plugin"


class QuestionSource(CamelModel):
    kind: QuestionSourceKind
    id: str = Field(min_length=1, max_length=120)
    provenance: Provenance | None = None


class QuestionCandidate(CamelModel):
    """A candidate question offered by a question source (pack, bank, plugin)."""

    skill_id: SkillId
    text: str = Field(min_length=10, max_length=1200)
    difficulty: QuestionDifficulty | None = None
    expected_concepts: (
        list[Annotated[str, StringConstraints(min_length=1, max_length=200)]] | None
    ) = Field(default=None, max_length=8)
    mode: ModeId | None = None
    source: QuestionSource
