"""Interview modes — port of `interview/modes/{types,index}.ts`.

Modes are plugin-provided (§9.1): the registry starts empty and only the legacy
`"mixed"` round resolves without plugins. Unknown ids get an `available: false`
placeholder so stored sessions keep rendering; availability is enforced by the
orchestrator, not here.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from .js_compat import to_fixed
from .models.assessment import AnswerEvaluation
from .models.interview import AnswerFormat, ModeState, RubricDimension
from .models.shared import CamelModel
from .models.skills import (
    AnswerFieldType,
    PluginModeDefinition,
)
from .skill_id import SkillId
from .taxonomy import children_of

__all__ = [
    "MIXED_MODE",
    "FollowUpDecision",
    "LoadedPluginMode",
    "ModeAnswerField",
    "ModeContextNeeds",
    "ModeDefinition",
    "ModePrompts",
    "ModeQuestionContext",
    "all_modes",
    "generic_follow_up",
    "get_mode",
    "in_subtree",
    "is_mode_available",
    "is_mode_id",
    "mode_plugin_id",
    "register_plugin_modes",
    "reset_plugin_modes",
    "rubric_score",
    "unregister_plugin_modes",
]


class FollowUpDecision(CamelModel):
    ask: bool
    # Short label the follow-up question should probe (missing concept/dimension).
    focus: str | None = None
    reason: str


class ModeQuestionContext(CamelModel):
    """The slice of a stored question the mode reducer sees."""

    skill_id: SkillId
    topic: str
    extra: dict[str, object] | None = None


class ModeAnswerField(CamelModel):
    """v1.1: one declarative answer widget for `answerFormat: "fields"` modes."""

    key: str
    label: str
    type: AnswerFieldType
    options: list[str] | None = None
    required: bool = False


class ModeContextNeeds(CamelModel):
    """Optional context a mode wants the host to feed the interviewer skill."""

    company_themes: bool = False
    story_titles: bool = False


@dataclass(frozen=True, slots=True)
class ModePrompts:
    interviewer: str | None = None
    evaluator: str | None = None


@dataclass(frozen=True, slots=True)
class ModeSource:
    plugin_id: str


@dataclass(frozen=True, slots=True)
class ModeDefinition:
    """§9.1: one self-contained interview mode — scope, rubric, state, follow-ups."""

    id: str
    label: str
    description: str
    answer_format: AnswerFormat
    answer_fields: tuple[ModeAnswerField, ...]
    available: bool
    in_scope: Callable[[str], bool]
    fallback_skills: tuple[SkillId, ...]
    rubric: tuple[RubricDimension, ...]
    initial_state: Callable[[], ModeState]
    reduce: Callable[[ModeState, AnswerEvaluation, ModeQuestionContext], ModeState]
    follow_up: Callable[[AnswerEvaluation, ModeState, int, int], FollowUpDecision]
    source: ModeSource | None = None
    prompts: ModePrompts | None = None
    context: ModeContextNeeds | None = None


@dataclass(frozen=True, slots=True)
class LoadedPluginMode:
    """A plugin mode descriptor plus its server-loaded prompt bodies."""

    definition: PluginModeDefinition
    prompts: ModePrompts = field(default_factory=ModePrompts)


def in_subtree(skill_id: str, root: str) -> bool:
    return skill_id == root or skill_id.startswith(f"{root}.")


def rubric_score(evaluation: AnswerEvaluation, rubric_id: str) -> float | None:
    for score in evaluation.rubric:
        if score.id == rubric_id:
            return score.score
    return None


def generic_follow_up(evaluation: AnswerEvaluation, depth: int, max_depth: int) -> FollowUpDecision:
    """Default follow-up rule: dig once per missing concept while a dimension is weak."""

    if depth >= max_depth:
        return FollowUpDecision(ask=False, reason="follow-up depth reached")
    weak = next((r for r in evaluation.rubric if r.score < 0.6), None)
    missing = evaluation.missing_concepts[0] if evaluation.missing_concepts else None
    if missing is not None and weak is not None:
        return FollowUpDecision(
            ask=True,
            focus=missing,
            reason=f'probing "{missing}" — {weak.label or weak.id} scored {to_fixed(weak.score)}',
        )
    return FollowUpDecision(
        ask=False,
        reason="concepts missed but rubric scores adequate"
        if missing is not None
        else "no missing concepts",
    )


MIXED_MODE = ModeDefinition(
    id="mixed",
    label="Mixed",
    description="Weakness-driven mix of all areas (legacy v0.2 round).",
    answer_format="text",
    answer_fields=(),
    available=True,
    in_scope=lambda _skill_id: True,
    fallback_skills=(),
    rubric=(),
    initial_state=lambda: {},
    reduce=lambda state, _evaluation, _question: state,
    follow_up=lambda _evaluation, _state, _depth, _max_depth: FollowUpDecision(
        ask=False, reason="mixed rounds do not follow up"
    ),
)

_plugin_modes: dict[str, ModeDefinition] = {}
_unavailable: dict[str, ModeDefinition] = {}


def _humanize(mode_id: str) -> str:
    words = [word for word in mode_id.replace("-", "_").split("_") if word]
    return " ".join(word[:1].upper() + word[1:] for word in words)


def _plugin_mode_definition(plugin_id: str, loaded: LoadedPluginMode) -> ModeDefinition:
    definition = loaded.definition
    include = definition.scope.include
    exclude = definition.scope.exclude
    fallback: list[SkillId] = (
        list(definition.fallback_skills)
        if definition.fallback_skills
        else [skill_id for root in include for skill_id in (root, *children_of(root))]
    )
    rules = definition.follow_up_rules or []
    follow_up_policy = definition.follow_up or ("rules" if rules else "generic")
    never_reason = (
        definition.follow_up_reason or f'mode "{definition.id}" does not chain follow-ups'
    )
    reduce_config = definition.reduce

    def reduce_state(
        state: ModeState, _evaluation: AnswerEvaluation, question: ModeQuestionContext
    ) -> ModeState:
        next_state: ModeState = dict(state)
        if reduce_config is not None:
            if reduce_config.set is not None:
                next_state.update(reduce_config.set)
            for key in reduce_config.copy_extra or []:
                value = (question.extra or {}).get(key)
                if value is not None:
                    next_state[key] = value
        return next_state

    def follow_up(
        evaluation: AnswerEvaluation, _state: ModeState, depth: int, max_depth: int
    ) -> FollowUpDecision:
        if follow_up_policy == "never":
            return FollowUpDecision(ask=False, reason=never_reason)
        if depth >= max_depth:
            return FollowUpDecision(ask=False, reason="follow-up depth reached")
        if follow_up_policy == "rules":
            for rule in rules:
                score = rubric_score(evaluation, rule.rubric_id)
                if score is not None and score < rule.below:
                    return FollowUpDecision(
                        ask=True,
                        focus=rule.focus,
                        reason=f"{rule.rubric_id} scored {to_fixed(score)} — probe {rule.focus}",
                    )
            return FollowUpDecision(ask=False, reason="no follow-up rule matched")
        return generic_follow_up(evaluation, depth, max_depth)

    return ModeDefinition(
        id=definition.id,
        label=definition.label,
        description=definition.description,
        answer_format=definition.answer_format,
        answer_fields=tuple(
            ModeAnswerField(
                key=field_.key,
                label=field_.label,
                type=field_.type,
                options=field_.options,
                required=field_.required,
            )
            for field_ in definition.answer_fields
        ),
        available=True,
        in_scope=lambda skill_id: (
            (not include or any(in_subtree(skill_id, root) for root in include))
            and not any(in_subtree(skill_id, root) for root in exclude)
        ),
        fallback_skills=tuple(fallback),
        rubric=tuple(definition.rubric),
        initial_state=lambda: dict(definition.initial_state),
        reduce=reduce_state,
        follow_up=follow_up,
        source=ModeSource(plugin_id=plugin_id),
        prompts=loaded.prompts,
        context=ModeContextNeeds(
            company_themes=definition.context.company_themes,
            story_titles=definition.context.story_titles,
        ),
    )


def _unavailable_mode(mode_id: str) -> ModeDefinition:
    """Placeholder for an id with no registered mode — history still renders."""

    existing = _unavailable.get(mode_id)
    if existing is not None:
        return existing
    created = ModeDefinition(
        id=mode_id,
        label=_humanize(mode_id),
        description=(
            f'Interview mode "{mode_id}" is not available (plugin not installed or disabled).'
        ),
        answer_format="text",
        answer_fields=(),
        available=False,
        in_scope=lambda _skill_id: False,
        fallback_skills=(),
        rubric=(),
        initial_state=lambda: {},
        reduce=lambda state, _evaluation, _question: state,
        follow_up=lambda _evaluation, _state, _depth, _max_depth: FollowUpDecision(
            ask=False, reason=f'mode "{mode_id}" is unavailable'
        ),
    )
    _unavailable[mode_id] = created
    return created


def register_plugin_modes(plugin_id: str, modes: Sequence[LoadedPluginMode]) -> None:
    """Register the modes a plugin declares; ids must not collide."""

    for mode in modes:
        mode_id = mode.definition.id
        if mode_id == "mixed":
            raise ValueError(
                f'plugin "{plugin_id}" mode "{mode_id}" collides with the reserved "mixed" round'
            )
        existing = _plugin_modes.get(mode_id)
        if existing is not None:
            assert existing.source is not None
            raise ValueError(
                f'plugin "{plugin_id}" mode "{mode_id}" collides with plugin '
                f'"{existing.source.plugin_id}"'
            )
    for mode in modes:
        _plugin_modes[mode.definition.id] = _plugin_mode_definition(plugin_id, mode)


def unregister_plugin_modes(plugin_id: str) -> None:
    for mode_id, definition in list(_plugin_modes.items()):
        if definition.source is not None and definition.source.plugin_id == plugin_id:
            del _plugin_modes[mode_id]


def reset_plugin_modes() -> None:
    """Test hook: drop every plugin-registered mode."""

    _plugin_modes.clear()


def get_mode(mode_id: str) -> ModeDefinition:
    """Resolve a mode id to its definition; unknown ids get the placeholder."""

    if mode_id == "mixed":
        return MIXED_MODE
    registered = _plugin_modes.get(mode_id)
    if registered is not None:
        return registered
    return _unavailable_mode(mode_id)


def all_modes() -> list[ModeDefinition]:
    """Registered plugin modes ("mixed" is a round type, not a mode)."""

    return list(_plugin_modes.values())


def is_mode_id(value: object) -> bool:
    """A registered plugin mode id — "mixed" is not a mode."""

    return isinstance(value, str) and value in _plugin_modes


def is_mode_available(value: object) -> bool:
    """A mode that new sessions may start with ("mixed" counts as a round type)."""

    return value == "mixed" or is_mode_id(value)


def mode_plugin_id(mode_id: str) -> str | None:
    """The owner plugin of a registered plugin mode id, if any."""

    definition = _plugin_modes.get(mode_id)
    if definition is None or definition.source is None:
        return None
    return definition.source.plugin_id
