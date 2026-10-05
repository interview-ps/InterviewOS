"""Platform models — port of `platform/{version,semver,mcp,ui-schema,export}.ts`.

Also holds the `plugin-api.ts` schemas the manifest depends on
(`PluginSettingField`/`PluginSettingValue`, `PluginAppliesTo`) plus
`PLUGIN_EVENT_NAMES`, so `models.skills` and `core.plugin_api` can share them
without an import cycle. `core.plugin_api` re-exports them.
"""

from __future__ import annotations

import json
import re
from enum import StrEnum
from typing import Annotated, Any, Literal, NamedTuple

from pydantic import Field, StringConstraints, TypeAdapter

from ..skill_id import SkillId
from .interview import RoundType
from .shared import CamelModel, JsonNumber, SlugId, StrictCamelModel

__all__ = [
    "APP_ROUTE_ALLOWLIST",
    "EXPORTED_SETTING_KEYS",
    "EXPORT_PARTS",
    "INTERVIEW_OS_VERSION",
    "MCP_ENV_NAME_PATTERN",
    "PLUGIN_EVENT_NAMES",
    "UI_TREE_LIMITS",
    "AnswerEvaluationRow",
    "CandidateAnswerRow",
    "CandidateProfileRow",
    "ExportBundle",
    "ExportCandidateSection",
    "ExportInterviewsSection",
    "ExportPart",
    "ExportPreparationSection",
    "ExportReadinessSection",
    "ExternalContext",
    "ExternalContextRow",
    "InterviewDebriefRow",
    "InterviewLoopRow",
    "InterviewPackRow",
    "InterviewQuestionRow",
    "InterviewSessionRow",
    "McpConfig",
    "McpServerConfig",
    "PluginAppliesTo",
    "PluginEventName",
    "PluginSettingField",
    "PluginSettingFieldType",
    "PluginSettingValue",
    "PreparationActionRow",
    "ReadinessScoreRow",
    "ResumeReviewRow",
    "Semver",
    "SkillEvidenceRow",
    "StarStoryRow",
    "TargetRoleRow",
    "UIAction",
    "UIActionNavigate",
    "UIActionOpenPluginPage",
    "UIActionRunPlugin",
    "UIActionStartInterview",
    "UIActionStartPractice",
    "UINode",
    "UINodeBadge",
    "UINodeButton",
    "UINodeCard",
    "UINodeDivider",
    "UINodeEmptyState",
    "UINodeEvidenceList",
    "UINodeHeading",
    "UINodeList",
    "UINodeProgressList",
    "UINodeReadinessChart",
    "UINodeRow",
    "UINodeSkillScore",
    "UINodeStack",
    "UINodeStat",
    "UINodeTabs",
    "UINodeText",
    "UITone",
    "UserQuestionRow",
    "compare_semver",
    "format_semver",
    "is_valid_version",
    "parse_version",
    "plugin_applies_to_skill",
    "satisfies",
    "ui_path_error",
    "validate_ui_tree",
]

INTERVIEW_OS_VERSION = "0.4.0"


class Semver(NamedTuple):
    major: int
    minor: int
    patch: int


_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def parse_version(version: str) -> Semver | None:
    match = _VERSION_RE.match(version.strip())
    if match is None:
        return None
    return Semver(int(match[1]), int(match[2]), int(match[3]))


def is_valid_version(version: str) -> bool:
    return parse_version(version) is not None


def compare_semver(a: Semver, b: Semver) -> int:
    return (a.major - b.major) or (a.minor - b.minor) or (a.patch - b.patch)


def format_semver(version: Semver) -> str:
    return f"{version.major}.{version.minor}.{version.patch}"


_COMPARATOR_RE = re.compile(r"^(>=|<=|>|<)?\s*(\d+)\.(\d+)\.(\d+)$")


def _caret_upper(version: Semver) -> Semver:
    if version.major > 0:
        return Semver(version.major + 1, 0, 0)
    if version.minor > 0:
        return Semver(0, version.minor + 1, 0)
    return Semver(0, 0, version.patch + 1)


def satisfies(version: str, range_spec: str) -> bool:
    """Minimal semver range check: `*`, exact `x.y.z`, `>=`, `>`, `<=`, `<`,
    `^x.y.z`, `~x.y.z`, and space-separated AND of comparators
    (e.g. `>=0.4.0 <0.5.0`). Unknown tokens make the whole range unsatisfied.
    """

    parsed = parse_version(version)
    if parsed is None:
        return False
    trimmed = range_spec.strip()
    if trimmed in ("", "*"):
        return True
    for token in re.split(r"\s+", trimmed):
        if token.startswith("^"):
            base = parse_version(token[1:])
            if (
                base is None
                or compare_semver(parsed, base) < 0
                or compare_semver(parsed, _caret_upper(base)) >= 0
            ):
                return False
            continue
        if token.startswith("~"):
            base = parse_version(token[1:])
            if base is None:
                return False
            upper = Semver(base.major, base.minor + 1, 0)
            if compare_semver(parsed, base) < 0 or compare_semver(parsed, upper) >= 0:
                return False
            continue
        match = _COMPARATOR_RE.match(token)
        if match is None:
            return False
        target = Semver(int(match[2]), int(match[3]), int(match[4]))
        comparison = compare_semver(parsed, target)
        operator = match[1] or ""
        if operator == ">=" and comparison < 0:
            return False
        if operator == "<=" and comparison > 0:
            return False
        if operator == ">" and comparison <= 0:
            return False
        if operator == "<" and comparison >= 0:
            return False
        if operator == "" and comparison != 0:
            return False
    return True


# --------------------------------------------------------------------- MCP (v0.4)

MCP_ENV_NAME_PATTERN = r"^[A-Z_][A-Z0-9_]*$"


class McpServerConfig(CamelModel):
    """v0.4 MCP: definitions live only in the local `interview-os.mcp.json`.

    `env_passthrough` holds env var NAMES (never values).
    """

    id: SlugId
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    command: str = Field(min_length=1, max_length=500)
    args: list[Annotated[str, StringConstraints(max_length=1000)]] = Field(
        default_factory=list, max_length=32
    )
    env_passthrough: list[Annotated[str, StringConstraints(pattern=MCP_ENV_NAME_PATTERN)]] = Field(
        default_factory=list, max_length=32
    )


class McpConfig(CamelModel):
    servers: list[McpServerConfig] = Field(default_factory=list, max_length=32)


class ExternalContext(CamelModel):
    """Stored, non-secret result of an allowed MCP tool call."""

    id: str = Field(min_length=1)
    server_id: SlugId
    tool: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(max_length=50_000)
    created_at: str = Field(min_length=1)


# ------------------------------------------------- plugin UI (v0.4, ui-schema)


class UITone(StrEnum):
    GREEN = "green"
    AMBER = "amber"
    RED = "red"
    BLUE = "blue"
    MUTED = "muted"


# Routes a plugin `navigate` action may target.
APP_ROUTE_ALLOWLIST: tuple[str, ...] = (
    "/",
    "/target",
    "/prepare",
    "/prepare/stories",
    "/interview",
    "/readiness",
    "/resume",
    "/history",
    "/skills",
    "/packs",
    "/settings",
)


class UIActionNavigate(StrictCamelModel):
    type: Literal["navigate"]
    # an allowlisted app route, or a path under the plugin's own /plugins/<id>
    to: str = Field(min_length=1, max_length=300)


class UIActionStartInterview(StrictCamelModel):
    type: Literal["startInterview"]
    round_type: RoundType | None = None
    # one of the plugin's declared interviewModes ids
    mode_id: SlugId | None = None
    planned_questions: int | None = Field(default=None, ge=1, le=10)


class UIActionStartPractice(StrictCamelModel):
    type: Literal["startPractice"]
    skill_id: SkillId


class UIActionRunPlugin(StrictCamelModel):
    type: Literal["runPlugin"]
    # arbitrary JSON payload re-sent to the plugin (≤ 2 KB)
    request: dict[str, Any]


class UIActionOpenPluginPage(StrictCamelModel):
    type: Literal["openPluginPage"]
    # path relative to /plugins/<id> — must start with "/"
    path: str = Field(pattern=r"^/", max_length=120)


UIAction = Annotated[
    UIActionNavigate
    | UIActionStartInterview
    | UIActionStartPractice
    | UIActionRunPlugin
    | UIActionOpenPluginPage,
    Field(discriminator="type"),
]


def ui_path_error(path: str) -> str | None:
    """A UI action path must be a plain in-app path — no traversal, escapes, or
    query/fragment smuggling. Returns the rejection reason or None."""

    if re.search(r"[\x00-\x1f\x7f]", path):
        return "contains a control character"
    if ".." in path:
        return "contains '..'"
    if "//" in path:
        return "contains '//'"
    if "\\" in path:
        return "contains a backslash"
    if re.search(r"[?#]", path):
        return "contains a query/fragment separator"
    if re.search(r"%2e|%2f", path, re.IGNORECASE):
        return "contains an encoded traversal character"
    return None


_TEXT_500 = Annotated[str, StringConstraints(max_length=500)]
_TEXT_500_MIN_1 = Annotated[str, StringConstraints(min_length=1, max_length=500)]


class UINodeStack(StrictCamelModel):
    type: Literal["stack"]
    gap: Literal["sm", "md", "lg"] | None = None
    children: list[UINode]


class UINodeRow(StrictCamelModel):
    type: Literal["row"]
    children: list[UINode]


class UINodeCard(StrictCamelModel):
    type: Literal["card"]
    title: _TEXT_500 | None = None
    subtitle: _TEXT_500 | None = None
    children: list[UINode]


class UINodeHeading(StrictCamelModel):
    type: Literal["heading"]
    text: _TEXT_500_MIN_1
    level: Literal[2, 3] = 2


class UINodeText(StrictCamelModel):
    type: Literal["text"]
    text: _TEXT_500_MIN_1
    tone: UITone | None = None


class UINodeStat(StrictCamelModel):
    type: Literal["stat"]
    label: _TEXT_500_MIN_1
    value: _TEXT_500_MIN_1
    trend: Literal["up", "down", "flat"] | None = None
    tone: UITone | None = None


class UINodeBadge(StrictCamelModel):
    type: Literal["badge"]
    text: _TEXT_500_MIN_1
    tone: UITone


class UINodeSkillScore(StrictCamelModel):
    type: Literal["skillScore"]
    skill_id: SkillId
    label: _TEXT_500 | None = None
    score: float | None = Field(ge=0, le=1)
    confidence: float | None = Field(default=None, ge=0, le=1)


class UINodeProgressListItem(StrictCamelModel):
    label: _TEXT_500_MIN_1
    value: float = Field(ge=0, le=1)
    tone: UITone | None = None


class UINodeProgressList(StrictCamelModel):
    type: Literal["progressList"]
    items: list[UINodeProgressListItem] = Field(max_length=50)


class UINodeListItem(StrictCamelModel):
    text: _TEXT_500_MIN_1
    tone: UITone | None = None


class UINodeList(StrictCamelModel):
    type: Literal["list"]
    items: list[UINodeListItem] = Field(max_length=50)


class UINodeEvidenceListItem(StrictCamelModel):
    skill_id: SkillId
    observation: _TEXT_500_MIN_1
    score: float | None = Field(default=None, ge=0, le=1)
    created_at: str | None = Field(default=None, max_length=40)


class UINodeEvidenceList(StrictCamelModel):
    type: Literal["evidenceList"]
    items: list[UINodeEvidenceListItem] = Field(max_length=50)


class UINodeReadinessChart(StrictCamelModel):
    type: Literal["readinessChart"]
    points: list[Annotated[float, Field(ge=0, le=1)]] = Field(max_length=200)
    label: _TEXT_500 | None = None


class UINodeTab(StrictCamelModel):
    label: _TEXT_500_MIN_1
    children: list[UINode]


class UINodeTabs(StrictCamelModel):
    type: Literal["tabs"]
    tabs: list[UINodeTab] = Field(min_length=1, max_length=8)


class UINodeEmptyState(StrictCamelModel):
    type: Literal["emptyState"]
    title: _TEXT_500_MIN_1
    description: _TEXT_500 | None = None


class UINodeDivider(StrictCamelModel):
    type: Literal["divider"]


class UINodeButton(StrictCamelModel):
    type: Literal["button"]
    label: _TEXT_500_MIN_1
    variant: Literal["primary", "secondary"] | None = None
    action: UIAction


UINode = Annotated[
    UINodeStack
    | UINodeRow
    | UINodeCard
    | UINodeHeading
    | UINodeText
    | UINodeStat
    | UINodeBadge
    | UINodeSkillScore
    | UINodeProgressList
    | UINodeList
    | UINodeEvidenceList
    | UINodeReadinessChart
    | UINodeTabs
    | UINodeEmptyState
    | UINodeDivider
    | UINodeButton,
    Field(discriminator="type"),
]

_UI_NODE_ADAPTER: TypeAdapter[Any] = TypeAdapter(UINode)

UI_TREE_LIMITS = {
    "maxDepth": 8,
    "maxNodes": 300,
    "maxSerializedBytes": 64 * 1024,
    "maxRunPluginRequestBytes": 2 * 1024,
}


def _check_action(action: Any, plugin_id: str | None, path: str) -> str | None:
    if isinstance(action, UIActionNavigate):
        to = action.to
        bad = ui_path_error(to)
        if bad:
            return f'{path}: navigate target "{to}" {bad}'
        if to in APP_ROUTE_ALLOWLIST:
            return None
        if plugin_id and (to == f"/plugins/{plugin_id}" or to.startswith(f"/plugins/{plugin_id}/")):
            return None
        return (
            f'{path}: navigate target "{to}" is not an allowlisted route '
            "or a page under this plugin"
        )
    if isinstance(action, UIActionRunPlugin):
        try:
            size = len(json.dumps(action.request))
        except (TypeError, ValueError):
            return f"{path}: runPlugin request is not JSON-serializable"
        if size > UI_TREE_LIMITS["maxRunPluginRequestBytes"]:
            return (
                f"{path}: runPlugin request exceeds "
                f"{UI_TREE_LIMITS['maxRunPluginRequestBytes']} bytes"
            )
        return None
    if isinstance(action, UIActionOpenPluginPage):
        bad = ui_path_error(action.path)
        if bad:
            return f'{path}: openPluginPage path "{action.path}" {bad}'
        return None
    return None


def validate_ui_tree(tree: object, *, plugin_id: str | None = None) -> Any:
    """Parse + bound a declarative UI tree.

    Raises `ValueError` describing the first violation. `plugin_id` enables the
    same-plugin navigate allowance.
    """

    try:
        serialized = json.dumps(tree)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"ui tree is not JSON-serializable: {exc}") from exc
    if len(serialized) > UI_TREE_LIMITS["maxSerializedBytes"]:
        raise ValueError(f"ui tree exceeds {UI_TREE_LIMITS['maxSerializedBytes']} bytes")
    parsed = _UI_NODE_ADAPTER.validate_python(tree)

    nodes = 0

    def walk(node: Any, depth: int, path: str) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > UI_TREE_LIMITS["maxNodes"]:
            raise ValueError(f"ui tree exceeds {UI_TREE_LIMITS['maxNodes']} nodes")
        if depth > UI_TREE_LIMITS["maxDepth"]:
            raise ValueError(f"ui tree exceeds depth {UI_TREE_LIMITS['maxDepth']}")
        if isinstance(node, UINodeButton):
            error = _check_action(node.action, plugin_id, path)
            if error:
                raise ValueError(error)
        children: list[Any] = []
        if isinstance(node, (UINodeStack, UINodeRow, UINodeCard)):
            children = node.children
        elif isinstance(node, UINodeTabs):
            children = [child for tab in node.tabs for child in tab.children]
        for index, child in enumerate(children):
            walk(child, depth + 1, f"{path}.{index}")

    walk(parsed, 1, "root")
    return parsed


# ------------------------------------------------------- export bundle (v0.4)

Json = Any
Stamp = str


class CandidateProfileRow(CamelModel):
    id: str = Field(min_length=1)
    active: int
    name: str | None
    headline: str | None
    resume_text: str
    data: Json
    created_at: Stamp


class TargetRoleRow(CamelModel):
    id: str = Field(min_length=1)
    active: int
    company: str
    role: str
    level: str
    job_description: str
    data: Json
    created_at: Stamp


class InterviewSessionRow(CamelModel):
    id: str = Field(min_length=1)
    candidate_id: str | None
    target_id: str | None
    status: str
    current_round: int
    planned_questions: int
    mode: str
    round_type: str
    focus_skill_id: str | None
    action_id: str | None
    mode_state: Json
    loop_id: str | None
    loop_round: int | None
    context_id: str | None
    created_at: Stamp
    completed_at: Stamp | None


class InterviewLoopRow(CamelModel):
    id: str = Field(min_length=1)
    target_id: str | None
    company_profile_id: str
    rounds: Json
    status: str
    pack_id: str | None
    focus_skills: Json
    current_round: int
    abandoned: int
    debrief: Json
    created_at: Stamp
    completed_at: Stamp | None


class InterviewQuestionRow(CamelModel):
    id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    skill_id: str
    topic: str
    text: str
    sub_skills: Json
    expected_concepts: Json
    difficulty: str
    selection_priority: float | None
    selection_reason: str | None
    selection_factors: Json
    follow_up_of: str | None
    follow_up_focus: str | None
    extra: Json
    position: int
    created_at: Stamp


class CandidateAnswerRow(CamelModel):
    id: str = Field(min_length=1)
    question_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    text: str
    code: str | None
    language: str | None
    voice: Json
    status: str
    created_at: Stamp


class AnswerEvaluationRow(CamelModel):
    id: str = Field(min_length=1)
    answer_id: str = Field(min_length=1)
    question_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    data: Json
    readiness_delta: Json
    created_at: Stamp


class InterviewDebriefRow(CamelModel):
    id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    data: Json
    created_at: Stamp


class SkillEvidenceRow(CamelModel):
    id: str = Field(min_length=1)
    candidate_id: str | None
    skill_id: str
    type: str
    score: float
    confidence: float
    observation: str
    session_id: str | None
    question_id: str | None
    source: str | None
    created_at: Stamp


class ReadinessScoreRow(CamelModel):
    id: int
    skill_id: str
    score: float | None
    confidence: float
    evidence_ids: Json
    reason: str
    computed_at: Stamp


class PreparationActionRow(CamelModel):
    id: str = Field(min_length=1)
    skill_id: str
    target_id: str | None
    priority: float
    reason: str
    action: str
    success_criteria: Json
    status: str
    severity: str
    created_at: Stamp
    source_evidence_ids: Json
    resources: Json


class StarStoryRow(CamelModel):
    id: str = Field(min_length=1)
    candidate_id: str = Field(min_length=1)
    title: str
    situation: str
    task: str
    action: str
    result: str
    skill_ids: Json
    source: str
    updated_at: Stamp


class ResumeReviewRow(CamelModel):
    id: str = Field(min_length=1)
    candidate_id: str | None
    target_id: str | None
    ats: Json
    suggestions: Json
    tailoring: Json
    linked_gap_skill_ids: Json
    guard: Json
    created_at: Stamp


class InterviewPackRow(CamelModel):
    id: str = Field(min_length=1)
    data: Json
    source: Literal["user", "imported"]
    created_at: Stamp
    updated_at: Stamp


class UserQuestionRow(CamelModel):
    id: str = Field(min_length=1)
    skill_id: str
    text: str
    difficulty: str | None
    mode: str | None
    created_at: Stamp


class ExternalContextRow(CamelModel):
    id: str = Field(min_length=1)
    server_id: str
    tool: str
    title: str
    text: str
    created_at: Stamp


class ExportCandidateSection(CamelModel):
    profiles: list[CandidateProfileRow]


class ExportReadinessSection(CamelModel):
    snapshots: list[ReadinessScoreRow]


class ExportInterviewsSection(CamelModel):
    sessions: list[InterviewSessionRow]
    questions: list[InterviewQuestionRow]
    answers: list[CandidateAnswerRow]
    evaluations: list[AnswerEvaluationRow]
    debriefs: list[InterviewDebriefRow]
    loops: list[InterviewLoopRow]


class ExportPreparationSection(CamelModel):
    actions: list[PreparationActionRow]


class ExportBundle(CamelModel):
    """v0.4 export/import bundle.

    Deliberately absent: runtime_sessions, plugin_installs, mcp_servers,
    usage_events — machine-local or security-sensitive state never exports.
    """

    format: Literal["interview-os.export"]
    version: Literal[1]
    app_version: str = Field(min_length=1)
    exported_at: Stamp
    candidate: ExportCandidateSection
    targets: list[TargetRoleRow]
    readiness: ExportReadinessSection
    evidence: list[SkillEvidenceRow]
    interviews: ExportInterviewsSection
    preparation: ExportPreparationSection
    stories: list[StarStoryRow]
    resume_reviews: list[ResumeReviewRow]
    interview_packs: list[InterviewPackRow]
    question_bank: list[UserQuestionRow]
    settings: dict[str, str]
    external_contexts: list[ExternalContextRow]


# Setting keys that may round-trip — user preferences, never runtime/machine state.
EXPORTED_SETTING_KEYS: tuple[str, ...] = ("questionSources", "voice", "model", "reasoningEffort")

EXPORT_PARTS: tuple[str, ...] = (
    "candidate",
    "targets",
    "readiness",
    "evidence",
    "interviews",
    "preparation",
)
ExportPart = Literal["candidate", "targets", "readiness", "evidence", "interviews", "preparation"]


# ------------------------------------ plugin-api schemas the manifest depends on

# Short event names accepted in manifest `events` (without the "events." prefix).
PLUGIN_EVENT_NAMES: tuple[str, ...] = (
    "sessionCompleted",
    "readinessUpdated",
    "answerEvaluated",
    "loopCompleted",
    "targetChanged",
)
PluginEventName = Literal[
    "sessionCompleted",
    "readinessUpdated",
    "answerEvaluated",
    "loopCompleted",
    "targetChanged",
]

PluginSettingValue = Annotated[str, StringConstraints(max_length=4000)] | JsonNumber | bool


class PluginSettingFieldType(StrEnum):
    STRING = "string"
    NUMBER = "number"
    BOOLEAN = "boolean"
    ENUM = "enum"


class PluginSettingField(CamelModel):
    """v0.4: one declared plugin setting field (auto-rendered config UI)."""

    key: SlugId
    label: str = Field(min_length=1, max_length=120)
    type: PluginSettingFieldType
    options: list[Annotated[str, StringConstraints(min_length=1, max_length=80)]] | None = Field(
        default=None, max_length=20
    )
    default: PluginSettingValue | None = None
    description: str | None = Field(default=None, max_length=300)


class PluginAppliesTo(CamelModel):
    """v0.4: hooks filter — which skills a plugin applies to (absent = all)."""

    skill_prefixes: list[Annotated[str, StringConstraints(min_length=1, max_length=80)]] | None = (
        Field(default=None, max_length=30)
    )


def plugin_applies_to_skill(applies_to: PluginAppliesTo | None, skill_id: str) -> bool:
    prefixes = applies_to.skill_prefixes if applies_to else None
    if not prefixes:
        return True
    return any(skill_id == prefix or skill_id.startswith(f"{prefix}.") for prefix in prefixes)
