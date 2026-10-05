"""Skill and plugin manifest models — port of `skills/{manifest,proposals,slug}.ts`."""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import Field, StringConstraints, TypeAdapter, ValidationError, model_validator

from ..skill_id import SkillId
from .interview import AnswerFormat, ModeId, RoundType, RubricDimension
from .platform import (
    PluginAppliesTo,
    PluginEventName,
    PluginSettingField,
    UIAction,
)
from .shared import SLUG_ID_REGEX, CamelModel, SlugId

__all__ = [
    "ANSWER_FIELD_TYPES",
    "PLUGIN_EVIDENCE_CONFIDENCE_CAP",
    "PLUGIN_EVIDENCE_MAX_PROPOSALS",
    "PLUGIN_INPUT_KEYS",
    "PLUGIN_UI_SLOTS",
    "PLUGIN_WRITABLE_PERMISSIONS",
    "SLUG_ID_REGEX",
    "AnswerFieldType",
    "EvidenceProposal",
    "NormalizedPluginCapability",
    "Permission",
    "PluginAnswerField",
    "PluginCapability",
    "PluginInputKey",
    "PluginInterviewMode",
    "PluginModeContext",
    "PluginModeDefinition",
    "PluginModeFollowUpRule",
    "PluginModeReduce",
    "PluginModeScope",
    "PluginOutputExtensions",
    "PluginTaxonomyNode",
    "PluginUIContribution",
    "PluginUIIcon",
    "PluginUISlot",
    "PluginUI",
    "SkillKind",
    "SkillManifest",
    "SkillManifestEngines",
    "SkillManifestInput",
    "SlugId",
    "is_plugin_writable",
    "is_write_permission",
    "plugin_evidence_proposals",
]


class Permission(StrEnum):
    """§9.6 permission names.

    Read permissions gate which state slices a skill's manifest may declare as
    inputs; write permissions gate persistence of a skill's outputs.
    `runtime.invoke` gates access to the AI runtime; `taxonomy.read` covers the
    shared skill taxonomy.
    """

    CANDIDATE_READ = "candidate.read"
    CANDIDATE_WRITE = "candidate.write"
    TARGET_READ = "target.read"
    TARGET_WRITE = "target.write"
    READINESS_READ = "readiness.read"
    EVIDENCE_WRITE = "evidence.write"
    INTERVIEW_READ = "interview.read"
    INTERVIEW_WRITE = "interview.write"
    STORIES_READ = "stories.read"
    STORIES_WRITE = "stories.write"
    RESUME_READ = "resume.read"
    RESUME_WRITE = "resume.write"
    PREPARATION_WRITE = "preparation.write"
    TAXONOMY_READ = "taxonomy.read"
    ANSWERS_READ = "answers.read"
    RUNTIME_INVOKE = "runtime.invoke"


# v0.4: the only `*.write` permission a plugin may request and be granted.
PLUGIN_WRITABLE_PERMISSIONS: tuple[Permission, ...] = (Permission.EVIDENCE_WRITE,)


def is_plugin_writable(permission: Permission) -> bool:
    return permission in PLUGIN_WRITABLE_PERMISSIONS


class PluginCapability(StrEnum):
    """v0.4: platform-facing capability tags for plugin discovery."""

    INTERVIEW = "interview"
    EVALUATION = "evaluation"
    QUESTION_SOURCE = "question_source"
    PREPARATION = "preparation"
    RESOURCES = "resources"
    COMPANY_PACK = "company_pack"
    ROLE_PACK = "role_pack"
    INTERVIEW_MODE = "interview_mode"
    # deprecated alias of "preparation" — normalized at load.
    CHECKLIST = "checklist"
    UI = "ui"


# Capability set after manifest load — "checklist" is normalized away.
NormalizedPluginCapability = PluginCapability


class SkillManifestInput(CamelModel):
    key: str = Field(min_length=1, max_length=64)
    permission: Permission


# v0.4 plugin UI extension points (slots a plugin may contribute to).
PLUGIN_UI_SLOTS: tuple[str, ...] = (
    "dashboard.cards",
    "dashboard.sidebar",
    "target.tabs",
    "prepare.activities",
    "interview.sidebar",
    "interview.toolbar",
    "interview.question",
    "readiness.panels",
    "resume.tabs",
    "settings.sections",
)


class PluginUISlot(StrEnum):
    DASHBOARD_CARDS = "dashboard.cards"
    DASHBOARD_SIDEBAR = "dashboard.sidebar"
    TARGET_TABS = "target.tabs"
    PREPARE_ACTIVITIES = "prepare.activities"
    INTERVIEW_SIDEBAR = "interview.sidebar"
    INTERVIEW_TOOLBAR = "interview.toolbar"
    INTERVIEW_QUESTION = "interview.question"
    READINESS_PANELS = "readiness.panels"
    RESUME_TABS = "resume.tabs"
    SETTINGS_SECTIONS = "settings.sections"


class PluginUIIcon(StrEnum):
    """Fixed icon vocabulary for plugin navigation items."""

    DATABASE = "database"
    CLOUD = "cloud"
    CODE = "code"
    BOOK = "book"
    CHART = "chart"
    PUZZLE = "puzzle"
    SHIELD = "shield"
    STAR = "star"


class PluginUIContribution(CamelModel):
    component: SlugId
    kind: Literal["declarative", "frame"]
    title: str | None = Field(default=None, max_length=120)
    # frame kind only — relative path under ui/, validated at load.
    entry: str | None = Field(default=None, max_length=200)


class PluginUINavItem(CamelModel):
    label: str = Field(min_length=1, max_length=60)
    icon: PluginUIIcon
    # path relative to /plugins/<id>
    page: str = Field(pattern=r"^/", max_length=120)


class PluginUICommand(CamelModel):
    id: SlugId
    label: str = Field(min_length=1, max_length=120)
    action: UIAction


class PluginUIPage(CamelModel):
    path: str = Field(pattern=r"^/", max_length=120)
    title: str = Field(min_length=1, max_length=120)
    kind: Literal["declarative", "frame"]
    component: SlugId
    entry: str | None = Field(default=None, max_length=200)


class PluginUI(CamelModel):
    navigation: list[PluginUINavItem] = Field(default_factory=list, max_length=2)
    commands: list[PluginUICommand] = Field(default_factory=list, max_length=5)
    slots: dict[PluginUISlot, list[PluginUIContribution]] = Field(default_factory=dict)
    pages: list[PluginUIPage] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def _slot_contributions_bounded(self) -> PluginUI:
        for slot, contributions in self.slots.items():
            if len(contributions) > 3:
                raise ValueError(f"slot {slot} accepts at most 3 contributions")
        return self


class PluginInterviewMode(CamelModel):
    """A plugin-declared interview mode surfaced on the interview start page."""

    id: SlugId
    label: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=300)
    round_type: RoundType
    focus_skills: list[SkillId] = Field(default_factory=list, max_length=12)
    planned_questions: int = Field(default=4, ge=1, le=10)
    # v0.4: untrusted pack-like guidance rendered into interviewer/evaluator prompts.
    guidance: str | None = Field(default=None, max_length=1500)


class PluginModeFollowUpRule(CamelModel):
    """v1: declarative follow-up rule for a plugin interview mode."""

    rubric_id: str = Field(min_length=1, max_length=60)
    below: float = Field(ge=0, le=1)
    focus: str = Field(min_length=1, max_length=120)


ANSWER_FIELD_TYPES: tuple[str, ...] = ("text", "code", "choice", "number")


class AnswerFieldType(StrEnum):
    TEXT = "text"
    CODE = "code"
    CHOICE = "choice"
    NUMBER = "number"


class PluginAnswerField(CamelModel):
    """v1.1: one declarative answer field for `answerFormat: "fields"` modes."""

    key: SlugId
    label: str = Field(min_length=1, max_length=80)
    type: AnswerFieldType
    # Required (≤ 20) for "choice" fields only.
    options: list[Annotated[str, StringConstraints(min_length=1, max_length=80)]] | None = Field(
        default=None, max_length=20
    )
    required: bool = False

    @model_validator(mode="after")
    def _options_match_type(self) -> PluginAnswerField:
        if self.type == AnswerFieldType.CHOICE and not self.options:
            raise ValueError(f'choice field "{self.key}" requires options')
        if self.type != AnswerFieldType.CHOICE and self.options is not None:
            raise ValueError("options are only valid on choice fields")
        return self


class PluginModeScope(CamelModel):
    """Taxonomy scoping: inScope = (include empty || any inSubtree(include))
    && !any inSubtree(exclude)."""

    include: list[SkillId] = Field(default_factory=list, max_length=30)
    exclude: list[SkillId] = Field(default_factory=list, max_length=30)


class PluginModeReduce(CamelModel):
    # question.extra keys copied into the mode state each turn.
    copy_extra: list[Annotated[str, StringConstraints(min_length=1, max_length=60)]] | None = Field(
        default=None, max_length=20
    )
    # constant keys set into the mode state each turn.
    set: dict[str, Any] | None = None


class PluginModeContext(CamelModel):
    """Host-side context the interviewer skill receives — never sent to the plugin."""

    company_themes: bool = False
    story_titles: bool = False


class PluginModeDefinition(CamelModel):
    """v1: a plugin-defined interview mode (manifest `modes`)."""

    id: ModeId
    label: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=300)
    scope: PluginModeScope = Field(default_factory=lambda: PluginModeScope(include=[], exclude=[]))
    # Empty candidate-pool fallbacks; defaults to each include root plus children.
    fallback_skills: list[SkillId] = Field(default_factory=list, max_length=30)
    # Independent dimensions the evaluator must score.
    rubric: list[RubricDimension] = Field(min_length=1, max_length=12)
    answer_format: AnswerFormat = "text"
    # v1.1: structured answer widgets — required iff answerFormat is "fields".
    answer_fields: list[PluginAnswerField] = Field(default_factory=list, max_length=8)
    initial_state: dict[str, Any] = Field(default_factory=dict)
    reduce: PluginModeReduce | None = None
    context: PluginModeContext = Field(
        default_factory=lambda: PluginModeContext(company_themes=False, story_titles=False)
    )
    # Follow-up policy: "generic", "rules", or "never". Defaults to "rules"
    # when followUpRules are present, else "generic".
    follow_up: Literal["generic", "rules", "never"] | None = None
    follow_up_reason: str | None = Field(default=None, min_length=1, max_length=200)
    follow_up_rules: list[PluginModeFollowUpRule] | None = Field(default=None, max_length=10)
    # Prompt file paths relative to the plugin dir (loaded by the host).
    interviewer_prompt: str | None = Field(default=None, min_length=1, max_length=200)
    evaluator_prompt: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def _answer_fields_match_format(self) -> PluginModeDefinition:
        if self.answer_format == "fields" and not self.answer_fields:
            raise ValueError('answerFormat "fields" requires at least one answerFields entry')
        if self.answer_format != "fields" and self.answer_fields:
            raise ValueError('answerFields require answerFormat "fields"')
        return self


class PluginTaxonomyNode(CamelModel):
    """Extra taxonomy nodes a plugin may register (same shape as role packs)."""

    id: SkillId
    label: str = Field(min_length=1, max_length=120)
    keywords: list[Annotated[str, StringConstraints(min_length=1, max_length=80)]] = Field(
        default_factory=list
    )


class SkillManifestEngines(CamelModel):
    interview_os: str = Field(min_length=1, max_length=80, alias="interview-os")
    plugin_api: str | None = Field(default=None, min_length=1, max_length=80, alias="plugin-api")


class SkillKind(StrEnum):
    BUILTIN = "builtin"
    PLUGIN = "plugin"


class SkillManifest(CamelModel):
    """§9.6: every skill (built-in or plugin) carries a manifest."""

    id: str = Field(min_length=1, max_length=80)
    version: str = Field(min_length=1, max_length=24)
    kind: SkillKind
    description: str = Field(default="", max_length=1000)
    inputs: list[SkillManifestInput] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)
    permissions: list[Permission] = Field(default_factory=list)
    # Display name; empty/missing means "use id".
    name: str | None = Field(default=None, max_length=120)
    author: str | None = Field(default=None, max_length=120)
    capabilities: list[PluginCapability] | None = None
    engines: SkillManifestEngines | None = None
    # v0.4 Plugin API v1: hooks this plugin implements.
    hooks: list[Annotated[str, StringConstraints(min_length=1, max_length=80)]] | None = Field(
        default=None, max_length=30
    )
    # v0.4: event subscriptions — short names (see PLUGIN_EVENT_NAMES).
    events: list[PluginEventName] | None = Field(default=None, max_length=8)
    # v0.4: which skills a hook applies to (absent = all).
    applies_to: PluginAppliesTo | None = None
    # v0.4: declared settings fields; values live in plugin_settings.
    settings: list[PluginSettingField] | None = Field(default=None, max_length=20)
    # v0.4: UI contributions — requires the "ui" capability (checked at load).
    ui: PluginUI | None = None
    # v0.4: plugin-declared interview modes ("<pluginId>:<modeId>").
    interview_modes: list[PluginInterviewMode] | None = Field(default=None, max_length=5)
    # v1: plugin-defined interview modes — requires the interview_mode capability.
    modes: list[PluginModeDefinition] | None = Field(default=None, max_length=5)
    # v0.4: extra taxonomy nodes registered at load.
    taxonomy: list[PluginTaxonomyNode] | None = Field(default=None, max_length=30)

    @model_validator(mode="after")
    def _normalize_capabilities(self) -> SkillManifest:
        # deprecated "checklist" alias normalizes to "preparation" (deduped).
        if self.capabilities is None:
            return self
        normalized: list[PluginCapability] = []
        for capability in self.capabilities:
            value = (
                PluginCapability.PREPARATION
                if capability == PluginCapability.CHECKLIST
                else capability
            )
            if value not in normalized:
                normalized.append(value)
        self.capabilities = normalized
        return self

    @model_validator(mode="after")
    def _modes_are_declared_consistently(self) -> SkillManifest:
        modes = self.modes or []
        if not modes:
            return self
        if PluginCapability.INTERVIEW_MODE not in (self.capabilities or []):
            raise ValueError("declaring modes requires the interview_mode capability")
        seen: set[str] = set()
        for index, mode in enumerate(modes):
            if mode.id in seen:
                raise ValueError(f'duplicate mode id "{mode.id}"')
            seen.add(mode.id)
            if mode.id == "mixed":
                raise ValueError('mode id "mixed" is reserved for the legacy mixed round')
            for key, path in (
                ("interviewerPrompt", mode.interviewer_prompt),
                ("evaluatorPrompt", mode.evaluator_prompt),
            ):
                if path is not None and _prompt_path_escapes(path):
                    raise ValueError(
                        f'modes.{index}.{key}: prompt path "{path}" must be a relative '
                        "path inside the plugin directory"
                    )
        return self


_PROMPT_PATH_INVALID = re.compile(r"^[a-zA-Z]:|^/")


def _prompt_path_escapes(path: str) -> bool:
    return _PROMPT_PATH_INVALID.search(path) is not None or "\\" in path or ".." in path.split("/")


# §9.6: state slices the host may assemble as plugin inputs, each mapped to the
# read permission that gates it. Plugin manifests may only declare these.
PLUGIN_INPUT_KEYS: dict[str, Permission] = {
    "candidate": Permission.CANDIDATE_READ,
    "target": Permission.TARGET_READ,
    "readiness": Permission.READINESS_READ,
    "gaps": Permission.READINESS_READ,
    "stories": Permission.STORIES_READ,
    "recentEvaluations": Permission.INTERVIEW_READ,
    "resume": Permission.RESUME_READ,
    "request": Permission.TAXONOMY_READ,
}

PluginInputKey = Literal[
    "candidate",
    "target",
    "readiness",
    "gaps",
    "stories",
    "recentEvaluations",
    "resume",
    "request",
]


def is_write_permission(permission: Permission) -> bool:
    return permission.endswith(".write")


# --------------------------------------------------------------- proposals


class EvidenceProposal(CamelModel):
    """v0.4: a plugin may propose evidence rows; the server validates, caps
    confidence, tags source `plugin:<id>` and persists them as type "plugin"
    only when `evidence.write` is granted."""

    skill_id: SkillId
    score: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    observation: str = Field(min_length=1, max_length=500)


PLUGIN_EVIDENCE_CONFIDENCE_CAP = 0.6
PLUGIN_EVIDENCE_MAX_PROPOSALS = 20


class PluginOutputExtensions(CamelModel):
    """Optional extension field a plugin's JSON output may carry."""

    evidence_proposals: list[EvidenceProposal] | None = Field(
        default=None, max_length=PLUGIN_EVIDENCE_MAX_PROPOSALS
    )


_EVIDENCE_PROPOSALS_ADAPTER: TypeAdapter[list[EvidenceProposal]] = TypeAdapter(
    Annotated[list[EvidenceProposal], Field(max_length=PLUGIN_EVIDENCE_MAX_PROPOSALS)]
)


def plugin_evidence_proposals(output: object) -> list[EvidenceProposal] | None:
    """Read the evidence proposals out of arbitrary plugin output.

    Returns `[]` when absent, `None` when present but invalid.
    """

    if not isinstance(output, dict):
        return []
    if "evidenceProposals" not in output:
        return []
    try:
        return _EVIDENCE_PROPOSALS_ADAPTER.validate_python(output["evidenceProposals"])
    except ValidationError:
        return None
