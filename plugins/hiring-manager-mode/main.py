"""Hiring-manager mode — port of `plugins/hiring-manager-mode/index.ts`.

Scope/rubric/context are declared in `plugin.yaml` `modes`; this entry ships
the `mode.reduce` hook (tracks covered themes) and the deterministic
`mode.mock` — identical to the former built-in mocks.
"""

from __future__ import annotations

from typing import Any, cast

from interview_os.core.plugin_api import (
    ModeMockRequest,
    ModeMockResponse,
    ModeReduceRequest,
    ModeReduceResponse,
)
from interview_os.plugins.context import PluginContext
from interview_os.plugins.testing.mock_helpers import (
    GENERIC_PROMPTS,
    STAR_PARTS,
    ConceptTemplate,
    concept,
    coverage_of,
    keywords_hit,
    pick_question,
    round2,
)

__all__ = ["HM_DIM_KEYWORDS", "HM_LABELS", "HiringManagerMode", "setup"]


def _template(
    text: str,
    topic: str,
    sub_skills: tuple[str, ...],
    expected_concepts: tuple[dict[str, Any], ...],
    difficulty: str,
) -> ConceptTemplate:
    return ConceptTemplate(
        text=text,
        topic=topic,
        sub_skills=sub_skills,
        expected_concepts=expected_concepts,  # type: ignore[arg-type]
        difficulty=difficulty,
    )


HM_TEMPLATES: tuple[ConceptTemplate, ...] = (
    _template(
        "Tell me about the most impactful project you've owned end-to-end — what was the scope "
        "and the measurable outcome?",
        "Scope and impact",
        ("hiring-manager.scope-impact",),
        (
            concept("Scope described", "hiring-manager.scope-impact", ["scope", "team", "owned", "led"]),
            concept(
                "Measurable impact",
                "hiring-manager.scope-impact",
                ["%", "users", "reduced", "increased", "result"],
            ),
        ),
        "medium",
    ),
    _template(
        "Tell me about a time you had to cut scope or deprioritize work you believed in — how did "
        "you decide?",
        "Prioritization trade-off",
        ("hiring-manager.prioritization",),
        (
            concept(
                "Trade-off explicit",
                "hiring-manager.prioritization",
                ["trade-off", "depriorit", "cut", "chose"],
            ),
            concept(
                "Decision rationale",
                "hiring-manager.prioritization",
                ["because", "rationale", "impact", "risk"],
            ),
        ),
        "medium",
    ),
    _template(
        "Tell me about a time you had to lead people through significant ambiguity or a change of "
        "direction.",
        "Leading through ambiguity",
        ("hiring-manager.leadership-style", "behavioral.leadership"),
        (
            concept(
                "Ambiguous context",
                "hiring-manager.leadership-style",
                ["ambigu", "unclear", "change", "pivot"],
            ),
            concept(
                "Leadership action",
                "behavioral.leadership",
                ["i led", "i organized", "i decided", "i aligned"],
            ),
        ),
        "hard",
    ),
    _template(
        "Why this team? What about this role matches where you want to go next?",
        "Why this team",
        ("hiring-manager.role-fit",),
        (
            concept(
                "Specific motivation",
                "hiring-manager.role-fit",
                ["because", "excited", "want to", "interested"],
            ),
            concept("Career direction", "hiring-manager.role-fit", ["grow", "learn", "goal", "next"]),
        ),
        "easy",
    ),
)

HM_TABLE: dict[str, tuple[ConceptTemplate, ...]] = {
    "hiring-manager": HM_TEMPLATES,
    "hiring-manager.role-fit": HM_TEMPLATES,
    "hiring-manager.scope-impact": HM_TEMPLATES,
    "hiring-manager.prioritization": HM_TEMPLATES,
    "hiring-manager.leadership-style": HM_TEMPLATES,
    "behavioral.leadership": HM_TEMPLATES,
    "communication": HM_TEMPLATES,
}

HM_DIM_KEYWORDS: dict[str, list[str]] = {
    "roleFit": ["role", "team", "excited", "fit", "match", "want to"],
    "scopeImpact": ["scope", "impact", "users", "%", "led", "owned", "result"],
    "prioritization": ["priorit", "trade-off", "depriorit", "chose", "cut", "roadmap"],
    "leadership": ["led", "influence", "aligned", "decided", "mentor", "ambigu"],
    "collaboration": ["stakeholder", "partner", "conflict", "team", "cross-functional", "aligned"],
    "motivation": ["because", "excited", "want to", "passionate", "goal", "grow", "learn"],
}

HM_LABELS: dict[str, str] = {
    "roleFit": "Role fit",
    "scopeImpact": "Scope & impact",
    "prioritization": "Prioritization",
    "leadership": "Leadership",
    "collaboration": "Collaboration",
    "motivation": "Motivation",
}


def _clamp(value: float) -> float:
    return round2(min(1.0, max(0.0, value)))


def _string_list(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def _star_hit(index: int, answer: str) -> bool:
    return STAR_PARTS[index].pattern.search(answer) is not None


def _reduce(req: ModeReduceRequest) -> dict[str, Any]:
    themes = _string_list(req.state.get("themesCovered"))
    if req.question.topic and req.question.topic not in themes:
        themes.append(req.question.topic)
    return {"themesCovered": themes}


def _interviewer_output(input_: dict[str, Any]) -> dict[str, Any]:
    skill_id = str(input_.get("skillId", ""))
    label = str(input_.get("label", ""))
    previous = _string_list(input_.get("previousQuestions"))
    follow_up = input_.get("followUp")
    raw_keywords = input_.get("skillKeywords")
    skill_keywords = _string_list(raw_keywords)
    if isinstance(follow_up, dict):
        focus = str(follow_up.get("focus", ""))
        return {
            "question": (
                f"Let's go deeper on {focus}: tell me more — what was your specific role and "
                "reasoning?"
            ),
            "topic": f"Follow-up: {focus}",
            "skillId": skill_id,
            "subSkills": [],
            "expectedConcepts": [concept(focus, skill_id, focus.split(" "))],
            "difficulty": "medium",
            "problem": None,
            "focusDimension": None,
        }
    template, rendered = pick_question(
        HM_TABLE, skill_id, label, previous, GENERIC_PROMPTS, skill_keywords
    )
    return {
        "question": rendered,
        "topic": template.topic,
        "skillId": skill_id,
        "subSkills": list(template.sub_skills),
        "expectedConcepts": [dict(item) for item in template.expected_concepts],
        "difficulty": template.difficulty,
        "problem": None,
        "focusDimension": None,
    }


def _evaluator_output(input_: dict[str, Any]) -> dict[str, Any]:
    raw_question = input_.get("question")
    question: dict[str, Any] = raw_question if isinstance(raw_question, dict) else {}
    answer = str(input_.get("answer", ""))
    raw_concepts = question.get("expectedConcepts")
    concepts = [item for item in raw_concepts if isinstance(item, dict)] if isinstance(raw_concepts, list) else []
    coverage = coverage_of(concepts, answer)  # type: ignore[arg-type]
    ratio = coverage.ratio
    words = len([word for word in answer.strip().split() if word])
    question_skill_id = str(question.get("skillId", ""))

    rubric = []
    for identifier, label in HM_LABELS.items():
        hits = keywords_hit(answer, HM_DIM_KEYWORDS[identifier])
        rubric.append(
            {
                "id": identifier,
                "label": label,
                "score": _clamp(0.2 if hits == 0 else 0.4 + 0.15 * hits),
                "rationale": "Not evidenced in the answer." if hits == 0 else f"{hits} relevant term(s).",
            }
        )
    by_id = {entry["id"]: entry for entry in rubric}

    is_narrative = _star_hit(0, answer) or _star_hit(2, answer)
    star = (
        {
            "situation": _star_hit(0, answer),
            "task": _star_hit(1, answer),
            "action": _star_hit(2, answer),
            "result": _star_hit(3, answer),
            "notes": "STAR parts detected by deterministic heuristics.",
        }
        if is_narrative
        else None
    )

    weaknesses = (
        [{"skill": "communication", "severity": "medium", "evidence": "Answer lacked a clear Result"}]
        if star is not None and not star["result"]
        else []
    )

    return {
        "summary": (
            f"Hiring-manager answer evaluated; {len(coverage.covered)}/{len(concepts)} expected "
            "signals covered."
        ),
        "dimensions": {
            "correctness": {"score": _clamp(0.3 + 0.5 * ratio), "rationale": "deterministic mock evaluation"},
            "technicalDepth": {"score": _clamp(0.2 + 0.6 * ratio), "rationale": "deterministic mock evaluation"},
            "reasoning": {"score": _clamp(0.25 + 0.5 * ratio), "rationale": "deterministic mock evaluation"},
            "structure": {"score": _clamp(min(0.9, 0.3 + words / 200)), "rationale": "deterministic mock evaluation"},
            "communication": {"score": _clamp(min(0.9, 0.3 + words / 120)), "rationale": "deterministic mock evaluation"},
            "evidence": {"score": _clamp(0.2 + 0.6 * ratio), "rationale": "deterministic mock evaluation"},
            "roleRelevance": {"score": by_id["roleFit"]["score"], "rationale": "deterministic mock evaluation"},
        },
        "strengths": [],
        "weaknesses": weaknesses,
        "scores": [
            {"skill": question_skill_id, "score": _clamp(0.15 + 0.8 * ratio), "confidence": 0.7},
            {"skill": "communication", "score": rubric[5]["score"], "confidence": 0.7},
        ],
        "missingConcepts": [item["concept"] for item in coverage.missing],
        "star": star,
        "rubric": rubric,
        "designUpdates": None,
        "betterApproach": "Be more specific about scope, impact, and your personal rationale.",
        "followUpTopics": [entry["id"] for entry in rubric if entry["score"] < 0.4],
    }


class HiringManagerMode:
    """`hook` middleware: `mode.reduce` + `mode.mock` for the hiring-manager round."""

    async def mode_reduce(self, req: ModeReduceRequest) -> ModeReduceResponse | None:
        return ModeReduceResponse(state=_reduce(req))

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse | None:
        if req.task == "interviewer":
            return ModeMockResponse(output=_interviewer_output(req.input))
        return ModeMockResponse(output=_evaluator_output(req.input))


def setup(ctx: PluginContext) -> None:
    ctx.middleware(HiringManagerMode())
