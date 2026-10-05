"""System-design mode — port of `plugins/system-design-mode/index.ts`.

The mode (scope, rubric, initial dimension-coverage state, "never" follow-up
policy) is declared in `plugin.yaml` `modes`; this entry ships:

- `mode.reduce`: rank-merge designUpdates into dimension coverage (never downgrades),
- `mode.prepareTurn`: the next uncovered dimension + mapped skill,
- `mode.mock`: deterministic MockRuntime output,
- `ui.render`: the design-dimensions sidebar panel.
"""

from __future__ import annotations

import re
from typing import Any, cast

from interview_os.core.plugin_api import (
    ModeMockRequest,
    ModeMockResponse,
    ModePrepareTurnRequest,
    ModePrepareTurnResponse,
    ModeReduceRequest,
    ModeReduceResponse,
    UiRenderRequest,
    UiRenderResponse,
)
from interview_os.plugins.context import PluginContext
from interview_os.plugins.testing.mock_helpers import (
    ConceptTemplate,
    concept,
    coverage_of,
    keywords_hit,
    round2,
)

__all__ = ["DIMENSION_LABELS", "DESIGN_DIMENSION_IDS", "SystemDesignMode", "setup"]

STATUS_RANK: dict[str, int] = {"not_covered": 0, "partial": 1, "covered": 2}

DESIGN_DIMENSION_IDS: tuple[str, ...] = (
    "requirements",
    "constraints",
    "scaleAssumptions",
    "architecture",
    "dataModel",
    "apis",
    "storage",
    "caching",
    "reliability",
    "scalability",
    "tradeOffs",
)

DIMENSION_LABELS: dict[str, str] = {
    "requirements": "Requirements",
    "constraints": "Constraints",
    "scaleAssumptions": "Scale assumptions",
    "architecture": "Architecture",
    "dataModel": "Data model",
    "apis": "APIs",
    "storage": "Storage",
    "caching": "Caching",
    "reliability": "Reliability",
    "scalability": "Scalability",
    "tradeOffs": "Trade-offs",
}

#: Maps a design rubric dimension to the taxonomy skill a probe targets.
DIMENSION_SKILL: dict[str, str] = {
    "requirements": "system-design.requirements-analysis",
    "constraints": "system-design",
    "scaleAssumptions": "system-design.capacity-estimation",
    "architecture": "system-design",
    "dataModel": "system-design.data-modeling",
    "apis": "apis",
    "storage": "sql",
    "caching": "distributed-systems.caching",
    "reliability": "system-design.reliability",
    "scalability": "system-design.scalability",
    "tradeOffs": "system-design",
}

DESIGN_PROBLEMS: tuple[str, ...] = (
    "Design a URL shortener service.",
    "Design a notification fan-out service (push/email/SMS) for a social app.",
    "Design a rate-limited public API gateway.",
)

#: Which skills each design problem exercises — picks turn-1's problem.
PROBLEM_SKILLS: tuple[tuple[str, ...], ...] = (
    ("apis", "sql", "system-design.data-modeling", "system-design"),
    (
        "distributed-systems.message-queues",
        "system-design.async-processing",
        "system-design.reliability",
        "distributed-systems",
    ),
    (
        "apis",
        "distributed-systems.caching",
        "system-design.scalability",
        "distributed-systems.caching.cache-invalidation",
    ),
)

DIMENSION_PROBES: dict[str, str] = {
    "requirements": "Let's pin down requirements: what are the core functional and non-functional requirements?",
    "constraints": "What constraints shape this design — latency targets, consistency needs, budget?",
    "scaleAssumptions": "Estimate the scale: expected QPS, storage growth, and bandwidth.",
    "architecture": "Sketch the high-level architecture: the main components and how data flows between them.",
    "dataModel": "What does the data model look like? Key entities and relationships.",
    "apis": "Define the API surface: which endpoints, and their request/response shape.",
    "storage": "What storage would you choose for each kind of data, and why?",
    "caching": "Where would you cache, what would you cache, and how do you invalidate?",
    "reliability": "How does the design handle failures — replication, retries, monitoring?",
    "scalability": "How does the system scale as traffic grows 10× or 100×?",
    "tradeOffs": "What are the main trade-offs you made, and what alternatives did you reject?",
}

DIM_KEYWORDS: dict[str, list[str]] = {
    "requirements": ["requirement", "clarif", "scope", "functional"],
    "constraints": ["constraint", "latency", "budget", "consistency"],
    "scaleAssumptions": [
        "qps",
        "users",
        "requests",
        "storage",
        "bandwidth",
        "estimate",
        "per second",
        "million",
    ],
    "architecture": [
        "component",
        "service",
        "load balanc",
        "gateway",
        "architecture",
        "client",
        "worker",
    ],
    "dataModel": ["table", "schema", "entity", "record", "column", "data model", "index"],
    "apis": ["endpoint", "api", "rest", "post ", "get ", "/shorten", "request"],
    "storage": ["database", "sql", "nosql", "postgres", "dynamodb", "s3", "blob", "key-value"],
    "caching": ["cache", "redis", "cdn", "invalidat", "memoiz"],
    "reliability": [
        "failover",
        "replica",
        "redundan",
        "availability",
        "retry",
        "monitoring",
        "alert",
    ],
    "scalability": ["scale", "shard", "partition", "horizontal", "load balanc"],
    "tradeOffs": ["trade-off", "tradeoff", "alternative", "versus", "chose", "instead"],
}

STATUS_LABEL: dict[str, str] = {
    "not_covered": "not covered",
    "partial": "partial",
    "covered": "covered",
}
STATUS_TONE: dict[str, str] = {"not_covered": "muted", "partial": "amber", "covered": "green"}

_CAMEL_SPLIT = re.compile(r"(?=[A-Z])")
_DESIGN_PREFIX = re.compile(r"^Design a |^Design an ")


def _template_for(problem: str) -> ConceptTemplate:
    return ConceptTemplate(
        text=f"{problem} Start by clarifying requirements and scale estimates.",
        topic=_DESIGN_PREFIX.sub("", problem).removesuffix("."),
        sub_skills=("system-design",),
        expected_concepts=(
            concept("requirements", "system-design.requirements", ["requirement", "clarif"]),
            concept(
                "scale estimate",
                "system-design.scale-estimation",
                ["qps", "users", "storage", "estimate", "requests"],
            ),
        ),
        difficulty="hard",
    )


DESIGN_TEMPLATES: tuple[ConceptTemplate, ...] = tuple(
    _template_for(problem) for problem in DESIGN_PROBLEMS
)


def _clamp(value: float) -> float:
    return round2(min(1.0, max(0.0, value)))


def _string_list(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def _dimensions_of(state: dict[str, Any]) -> dict[str, Any]:
    raw = state.get("dimensions")
    if isinstance(raw, dict):
        return raw
    return {dim: {"status": "not_covered", "notes": ""} for dim in DESIGN_DIMENSION_IDS}


def _next_uncovered_dimension(dimensions: dict[str, Any]) -> str | None:
    for dim in DESIGN_DIMENSION_IDS:
        entry = dimensions.get(dim)
        if not isinstance(entry, dict) or entry.get("status") != "covered":
            return dim
    return None


def _dimension_status(dimensions: dict[str, Any], dim: str) -> str | None:
    entry = dimensions.get(dim)
    if isinstance(entry, dict):
        status = entry.get("status")
        return status if isinstance(status, str) else None
    return None


def _overlap(skill_id: str, related: str) -> int:
    left = skill_id.split(".")
    right = related.split(".")
    shared = 0
    while shared < len(left) and shared < len(right) and left[shared] == right[shared]:
        shared += 1
    return shared


def _reduce(req: ModeReduceRequest) -> dict[str, Any]:
    state = req.state
    dimensions = dict(_dimensions_of(state))
    next_state: dict[str, Any] = {**state, "dimensions": dimensions}
    problem = req.question.extra.get("problem")
    if isinstance(problem, str) and problem:
        next_state["problem"] = problem
    focus = req.question.extra.get("focusDimension")
    if isinstance(focus, str) and focus:
        next_state["focusDimension"] = focus
    # v1.1: dimension updates travel in modeSignals.designUpdates; the legacy
    # top-level designUpdates field is the fallback for older evaluators.
    signaled = req.evaluation.mode_signals.get("designUpdates") if req.evaluation.mode_signals else None
    updates = signaled if isinstance(signaled, list) else req.evaluation.design_updates
    for update in updates or []:
        dimension = (
            update.get("dimension") if isinstance(update, dict) else getattr(update, "dimension", None)
        )
        status = update.get("status") if isinstance(update, dict) else getattr(update, "status", None)
        notes = update.get("notes", "") if isinstance(update, dict) else getattr(update, "notes", "")
        if not isinstance(dimension, str) or status is None:
            continue
        current = dimensions.get(dimension)
        if not isinstance(current, dict):
            continue
        rank = STATUS_RANK.get(str(status), 0)
        current_rank = STATUS_RANK.get(str(current.get("status")), 0)
        if rank > current_rank:
            dimensions[dimension] = {
                "status": str(status),
                "notes": notes or current.get("notes", ""),
            }
        elif notes and rank == current_rank:
            current["notes"] = notes
    return next_state


def _interviewer_output(input_: dict[str, Any]) -> dict[str, Any]:
    skill_id = str(input_.get("skillId", ""))
    previous = _string_list(input_.get("previousQuestions"))
    raw_mode_state = input_.get("modeState")
    mode_state: dict[str, Any] = raw_mode_state if isinstance(raw_mode_state, dict) else {}
    mode_dimensions = _dimensions_of(mode_state)
    follow_up = input_.get("followUp")

    if isinstance(follow_up, dict):
        focus = str(follow_up.get("focus", ""))
        lowered = focus.lower()
        dim = next((name for name in DIMENSION_PROBES if name.lower() in lowered), None)
        question = (
            f"Let's go deeper on {dim}: {DIMENSION_PROBES[dim]}"
            if dim is not None
            else f"Let's go deeper on {focus}: walk me through the specifics and the trade-offs."
        )
        return {
            "question": question,
            "topic": f"Follow-up: {focus}",
            "skillId": skill_id,
            "subSkills": [],
            "expectedConcepts": [concept(focus, skill_id, focus.split(" "))],
            "difficulty": "medium",
            "problem": None,
            "focusDimension": dim,
        }

    if not mode_state.get("problem"):
        # turn 1 is always a design problem — pick the one with the best skill
        # overlap (ties → earliest problem).
        best = 0
        best_score = -1
        for index, template in enumerate(DESIGN_TEMPLATES):
            if template.text in previous:
                continue
            score = max((_overlap(skill_id, skill) for skill in PROBLEM_SKILLS[index]), default=0)
            if score > best_score:
                best_score = score
                best = index
        picked = DESIGN_TEMPLATES[best]
        return {
            "question": picked.text,
            "topic": picked.topic,
            "skillId": skill_id,
            "subSkills": list(picked.sub_skills),
            "expectedConcepts": [dict(item) for item in picked.expected_concepts],
            "difficulty": picked.difficulty,
            "problem": DESIGN_PROBLEMS[best],
            "focusDimension": None,
        }

    uncovered = next(
        (
            name
            for name in DIMENSION_PROBES
            if _dimension_status(mode_dimensions, name) != "covered"
            and DIMENSION_PROBES[name] not in previous
        ),
        None,
    )
    dim = uncovered if uncovered is not None else "tradeOffs"
    return {
        "question": DIMENSION_PROBES[dim],
        "topic": f"Probe: {dim}",
        "skillId": skill_id,
        "subSkills": ["system-design"],
        "expectedConcepts": [
            concept(dim, "system-design", [part.lower() for part in _CAMEL_SPLIT.split(dim)])
        ],
        "difficulty": "medium",
        "problem": None,
        "focusDimension": dim,
    }


def _evaluator_output(input_: dict[str, Any]) -> dict[str, Any]:
    raw_question = input_.get("question")
    question: dict[str, Any] = raw_question if isinstance(raw_question, dict) else {}
    answer = str(input_.get("answer", ""))
    raw_mode_state = input_.get("modeState")
    mode_state: dict[str, Any] = raw_mode_state if isinstance(raw_mode_state, dict) else {}
    mode_dimensions = _dimensions_of(mode_state)
    raw_concepts = question.get("expectedConcepts")
    concepts = (
        [item for item in raw_concepts if isinstance(item, dict)]
        if isinstance(raw_concepts, list)
        else []
    )
    coverage = coverage_of(concepts, answer)  # type: ignore[arg-type]
    ratio = coverage.ratio
    words = len([word for word in answer.strip().split() if word])

    rubric = []
    for dim, keywords in DIM_KEYWORDS.items():
        hits = keywords_hit(answer, keywords)
        score = round2(min(1.0, 0.15 if hits == 0 else 0.35 + 0.2 * hits))
        rubric.append(
            {
                "id": dim,
                "label": DIMENSION_LABELS[dim],
                "score": score,
                "rationale": "Not discussed this turn." if hits == 0 else f"{hits} relevant term(s) detected.",
            }
        )

    design_updates = []
    for entry in rubric:
        score = entry["score"]
        proposed = "covered" if score >= 0.75 else ("partial" if score >= 0.4 else "not_covered")
        current = _dimension_status(mode_dimensions, entry["id"]) or "not_covered"
        if STATUS_RANK.get(proposed, 0) > STATUS_RANK.get(current, 0):
            design_updates.append(
                {
                    "dimension": entry["id"],
                    "status": "covered" if score >= 0.75 else "partial",
                    "notes": entry["rationale"],
                }
            )

    return {
        "summary": f"Design turn evaluated; {len(design_updates)} dimension(s) updated.",
        "dimensions": {
            "correctness": {"score": _clamp(0.3 + 0.5 * ratio), "rationale": "deterministic mock evaluation"},
            "technicalDepth": {"score": _clamp(0.2 + 0.7 * ratio), "rationale": "deterministic mock evaluation"},
            "reasoning": {"score": _clamp(0.25 + 0.5 * ratio), "rationale": "deterministic mock evaluation"},
            "structure": {"score": _clamp(min(0.9, 0.3 + words / 250)), "rationale": "deterministic mock evaluation"},
            "communication": {"score": _clamp(min(0.9, 0.3 + words / 120)), "rationale": "deterministic mock evaluation"},
            "evidence": {"score": _clamp(0.2 + 0.6 * ratio), "rationale": "deterministic mock evaluation"},
            "roleRelevance": {"score": _clamp(0.4 + 0.4 * ratio), "rationale": "deterministic mock evaluation"},
        },
        "strengths": [],
        "weaknesses": [
            {"skill": "system-design", "severity": "medium", "evidence": f"{entry['label']} not addressed"}
            for entry in rubric
            if entry["score"] < 0.3
        ][:3],
        "scores": [
            {"skill": str(question.get("skillId", "")), "score": _clamp(0.15 + 0.8 * ratio), "confidence": 0.7},
            *[
                {"skill": "system-design", "score": entry["score"], "confidence": 0.7}
                for entry in rubric
                if entry["score"] >= 0.4
            ][:4],
        ],
        "missingConcepts": [entry["label"] for entry in rubric if entry["score"] < 0.3],
        "star": None,
        "rubric": rubric,
        "designUpdates": None,
        "modeSignals": {"designUpdates": design_updates} if design_updates else None,
        "betterApproach": "Cover more design dimensions with concrete numbers.",
        "followUpTopics": [entry["id"] for entry in rubric if entry["score"] < 0.4],
    }


def _design_dimensions_panel(params: dict[str, Any]) -> dict[str, Any]:
    raw_state = params.get("state")
    state: dict[str, Any] = raw_state if isinstance(raw_state, dict) else {}
    dimensions = _dimensions_of(state)
    raw_focus = params.get("focus")
    focus = raw_focus if isinstance(raw_focus, str) else None
    children: list[dict[str, Any]] = []
    problem = state.get("problem")
    if isinstance(problem, str) and problem:
        children.append({"type": "text", "text": problem[:500], "tone": "muted"})
    rows: list[dict[str, Any]] = []
    for dimension, entry in dimensions.items():
        status = entry.get("status") if isinstance(entry, dict) else None
        status_label = STATUS_LABEL.get(status, status) if isinstance(status, str) else "not covered"
        label = DIMENSION_LABELS.get(dimension, dimension)
        rows.append(
            {
                "type": "row",
                "children": [
                    {
                        "type": "text",
                        "text": f"▸ {label}" if focus == dimension else label,
                        "tone": "blue" if focus == dimension else None,
                    },
                    {"type": "badge", "text": status_label, "tone": STATUS_TONE.get(status, "muted")},
                ],
            }
        )
    children.append({"type": "stack", "gap": "sm", "children": rows})
    return {"type": "card", "title": "Design dimensions", "children": children}


class SystemDesignMode:
    """`hook` middleware: reduce / prepareTurn / mock / ui.render for system design."""

    async def mode_reduce(self, req: ModeReduceRequest) -> ModeReduceResponse | None:
        return ModeReduceResponse(state=_reduce(req))

    async def mode_prepare_turn(
        self, req: ModePrepareTurnRequest
    ) -> ModePrepareTurnResponse | None:
        dimensions = _dimensions_of(req.state)
        focus = None if req.follow_up else _next_uncovered_dimension(dimensions)
        skill_id = (DIMENSION_SKILL.get(focus) or "system-design") if focus is not None else None
        return ModePrepareTurnResponse(turn={"focusDimension": focus, "skillId": skill_id})

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse | None:
        if req.task == "interviewer":
            return ModeMockResponse(output=_interviewer_output(req.input))
        return ModeMockResponse(output=_evaluator_output(req.input))

    async def ui_render(self, req: UiRenderRequest) -> UiRenderResponse | None:
        if req.component != "design-dimensions":
            return UiRenderResponse(ui={"type": "emptyState", "title": "Unknown component"})
        params = req.params if isinstance(req.params, dict) else {}
        return UiRenderResponse(ui=_design_dimensions_panel(cast("dict[str, Any]", params)))


def setup(ctx: PluginContext) -> None:
    ctx.middleware(SystemDesignMode())
