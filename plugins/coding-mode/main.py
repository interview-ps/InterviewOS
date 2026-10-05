"""Coding mode — port of `plugins/coding-mode/index.ts`.

The mode itself (rubric, scope, reduce, follow-up rules) is declared in
`plugin.yaml` `modes`; this entry ships the `mode.mock` hook (deterministic
MockRuntime output, identical to the former built-in coding mocks) and the
declarative `coding-problem` question-panel UI.
"""

from __future__ import annotations

import re
from typing import Any

from interview_os.core.js_compat import js_round
from interview_os.core.plugin_api import (
    ModeMockRequest,
    ModeMockResponse,
    UiRenderRequest,
    UiRenderResponse,
)
from interview_os.plugins.context import PluginContext
from interview_os.plugins.testing.mock_helpers import (
    GENERIC_PROMPTS,
    ConceptTemplate,
    concept,
    coverage_of,
    keywords_hit,
    pick_question,
    round2,
)

__all__ = ["CODING_KEYWORDS", "CodingMode", "setup"]

#: Coding subtree keywords (mirrors the core taxonomy for generic fallbacks).
CODING_KEYWORDS: dict[str, list[str]] = {
    "coding": [
        "coding",
        "coding challenge",
        "algorithm",
        "algorithms",
        "live coding",
        "whiteboard",
        "leetcode",
    ],
    "coding.algorithms": [
        "algorithm",
        "algorithms",
        "two pointers",
        "sliding window",
        "binary search",
        "recursion",
        "dynamic programming",
        "bfs",
        "dfs",
        "sorting",
    ],
    "coding.data-structures": [
        "data structure",
        "data structures",
        "hash map",
        "hash table",
        "linked list",
        "binary tree",
        "heap",
        "trie",
        "stack",
        "deque",
    ],
    "coding.complexity": [
        "big-o",
        "o(n",
        "time complexity",
        "space complexity",
        "complexity analysis",
        "runtime complexity",
    ],
    "coding.edge-cases": [
        "edge case",
        "edge cases",
        "corner case",
        "boundary condition",
        "empty input",
        "off-by-one",
        "unit test",
        "unit tests",
        "test case",
    ],
    "coding.code-quality": [
        "clean code",
        "readable code",
        "code quality",
        "refactor",
        "refactoring",
        "naming",
        "modular",
    ],
}

CODING_PROBLEM_DATA: tuple[dict[str, Any], ...] = (
    {
        "title": "Top-K recent items",
        "statement": (
            "Implement `recentK(items: number[], k: number)` returning the k most recently seen "
            "distinct values, newest first. Items arrive as an array in order."
        ),
        "constraints": ["1 ≤ k ≤ items.length", "items may contain duplicates", "aim for O(n) time"],
        "examples": [
            {
                "input": "items=[1,2,3,2,4], k=3",
                "output": "[4,2,3]",
                "explanation": "4 is newest; the earlier 2 keeps only its latest position.",
            }
        ],
    },
    {
        "title": "Merge overlapping intervals",
        "statement": (
            "Implement `merge(intervals: [number,number][])` returning the sorted list of merged "
            "non-overlapping intervals."
        ),
        "constraints": ["intervals.length up to 10^4", "intervals may be unsorted", "endpoints inclusive"],
        "examples": [
            {
                "input": "[[1,3],[8,10],[2,6],[15,18]]",
                "output": "[[1,6],[8,10],[15,18]]",
                "explanation": "[1,3] and [2,6] overlap → [1,6].",
            }
        ],
    },
    {
        "title": "LRU cache",
        "statement": (
            "Implement an LRU cache with `get(key)` and `put(key, value)` in O(1) each, evicting "
            "the least-recently-used entry when at capacity."
        ),
        "constraints": ["capacity ≥ 1", "both operations O(1)", "eviction on put when full"],
        "examples": [
            {
                "input": "cap=2; put(1,1); put(2,2); get(1); put(3,3)",
                "output": "key 2 evicted",
                "explanation": "get(1) made 1 most-recent; 2 is least-recent and evicted.",
            }
        ],
    },
    {
        "title": "Sliding-window rate limiter",
        "statement": (
            "Implement `allow(userId, ts)` that permits at most N requests per user within a "
            "trailing T-second window."
        ),
        "constraints": ["timestamps are monotonically increasing", "memory per user should stay bounded"],
        "examples": [
            {
                "input": "N=3, T=60; requests at t=0,10,20,30",
                "output": "first three allowed, fourth rejected",
                "explanation": "At t=30, three earlier requests fall inside the last 60s.",
            }
        ],
    },
)

PROBLEMS: tuple[ConceptTemplate, ...] = (
    ConceptTemplate(
        text="Solve this problem: first explain your approach, then write the code.",
        topic="Top-K recent items",
        sub_skills=("coding.data-structures",),
        expected_concepts=(
            concept("hash map / set for dedup", "coding.data-structures", ["hash", "map", "set"]),
            concept("O(n) time claim", "coding.complexity", ["o(n)", "linear", "time complexity"]),
            concept(
                "edge cases (empty, k=0, dupes)",
                "coding.edge-cases",
                ["edge", "empty", "duplicate"],
            ),
        ),
        difficulty="medium",
    ),
    ConceptTemplate(
        text="Solve this problem: first explain your approach, then write the code.",
        topic="Merge intervals",
        sub_skills=("coding.algorithms",),
        expected_concepts=(
            concept("sort by start", "coding.algorithms", ["sort"]),
            concept("single pass merge", "coding.algorithms", ["merge", "overlap", "previous"]),
            concept("O(n log n) complexity", "coding.complexity", ["n log n", "o(n", "complexity"]),
        ),
        difficulty="medium",
    ),
    ConceptTemplate(
        text="Design and implement this data structure — explain your approach first, then code it.",
        topic="LRU cache",
        sub_skills=("coding.data-structures",),
        expected_concepts=(
            concept("hash map + doubly-linked list", "coding.data-structures", ["linked", "map", "hash"]),
            concept("O(1) operations", "coding.complexity", ["o(1)", "constant"]),
            concept("move-to-front on access", "coding.data-structures", ["recent", "front", "move"]),
        ),
        difficulty="hard",
    ),
    ConceptTemplate(
        text="Solve this problem: first explain your approach, then write the code.",
        topic="Rate limiter",
        sub_skills=("coding.data-structures", "coding.algorithms"),
        expected_concepts=(
            concept("deque/queue of timestamps", "coding.data-structures", ["queue", "deque", "timestamps"]),
            concept("evict outside window", "coding.algorithms", ["window", "evict", "pop", "remove"]),
            concept("per-request O(1) amortized", "coding.complexity", ["o(1)", "amortized", "o(n)"]),
        ),
        difficulty="hard",
    ),
)

#: `pick_question` returns the template object itself, so identity maps the
#: chosen template back to its problem (two templates share the same text).
PROBLEM_BY_ID: dict[int, dict[str, Any]] = {
    id(template): data for template, data in zip(PROBLEMS, CODING_PROBLEM_DATA, strict=True)
}

CODING_TABLE: dict[str, tuple[ConceptTemplate, ...]] = {
    "coding": PROBLEMS,
    "coding.algorithms": PROBLEMS,
    "coding.data-structures": PROBLEMS,
    "coding.complexity": PROBLEMS,
    "coding.edge-cases": PROBLEMS,
    "coding.code-quality": PROBLEMS,
}

RUBRIC_LABELS: dict[str, str] = {
    "problemUnderstanding": "Problem understanding",
    "approach": "Approach",
    "correctness": "Correctness",
    "complexity": "Complexity",
    "edgeCases": "Edge cases",
    "codeQuality": "Code quality",
    "communication": "Communication",
}

_APPROACH_RE = re.compile(r"approach|plan|first|then|step", re.IGNORECASE)


def _clamp(value: float) -> float:
    return round2(min(1.0, max(0.0, value)))


def _string_list(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def _interviewer_output(input_: dict[str, Any]) -> dict[str, Any]:
    skill_id = str(input_.get("skillId", ""))
    label = str(input_.get("label", ""))
    previous = _string_list(input_.get("previousQuestions"))
    follow_up = input_.get("followUp")
    raw_keywords = input_.get("skillKeywords")
    skill_keywords = (
        _string_list(raw_keywords)
        if isinstance(raw_keywords, list)
        else CODING_KEYWORDS.get(skill_id, [])
    )

    if isinstance(follow_up, dict):
        focus = str(follow_up.get("focus", ""))
        return {
            "question": (
                f"Let's go deeper on {focus}: for the same problem, walk me through it — what are "
                "the exact considerations and how does your solution handle them?"
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
        CODING_TABLE, skill_id, label, previous, GENERIC_PROMPTS, skill_keywords
    )
    problem = PROBLEM_BY_ID.get(id(template)) or CODING_PROBLEM_DATA[0]
    return {
        "question": f"{problem['title']}: {rendered}",
        "topic": problem["title"],
        "skillId": skill_id,
        "subSkills": list(template.sub_skills),
        "expectedConcepts": [dict(item) for item in template.expected_concepts],
        "difficulty": template.difficulty,
        "problem": problem,
        "focusDimension": None,
    }


def _evaluator_output(input_: dict[str, Any]) -> dict[str, Any]:
    raw_question = input_.get("question")
    question: dict[str, Any] = raw_question if isinstance(raw_question, dict) else {}
    answer = str(input_.get("answer", ""))
    raw_code = input_.get("code")
    code = raw_code if isinstance(raw_code, str) else ""
    raw_language = input_.get("language")
    language = raw_language if isinstance(raw_language, str) else None
    raw_concepts = question.get("expectedConcepts")
    concepts = (
        [item for item in raw_concepts if isinstance(item, dict)]
        if isinstance(raw_concepts, list)
        else []
    )
    question_skill_id = str(question.get("skillId", ""))

    coverage = coverage_of(concepts, answer)  # type: ignore[arg-type]
    ratio = coverage.ratio
    text = f"{answer}\n{code}"
    words = len([word for word in answer.strip().split() if word])
    code_len = len(code.strip())

    complexity_hit = keywords_hit(
        text, ["o(", "big-o", "complexity", "linear", "quadratic", "constant time"]
    )
    edge_hit = keywords_hit(
        text, ["edge", "empty", "null", "duplicate", "boundary", "overflow", "negative"]
    )

    if code_len == 0:
        code_quality = 0.3
        code_rationale = f"No code submitted{'' if language else ' (language n/a)'}."
    elif code_len > 600:
        code_quality = 0.55
        code_rationale = f"Code submitted ({language if language is not None else 'text'}, {code_len} chars)."
    else:
        code_quality = 0.45 + min(0.3, code_len / 400)
        code_rationale = f"Code submitted ({language if language is not None else 'text'}, {code_len} chars)."

    rubric = [
        {
            "id": "problemUnderstanding",
            "score": _clamp(0.4 + 0.3 * ratio + (0.15 if len(answer) > 60 else 0)),
            "rationale": "Derived from restating the goal and constraints.",
        },
        {
            "id": "approach",
            "score": _clamp(0.3 + 0.4 * ratio + (0.2 if _APPROACH_RE.search(answer) else 0)),
            "rationale": "Whether an approach was articulated.",
        },
        {
            "id": "correctness",
            "score": _clamp(0.3 + 0.5 * ratio + (0.1 if code_len > 40 else 0)),
            "rationale": "Plausibility of the described/written solution.",
        },
        {
            "id": "complexity",
            "score": _clamp(0.5 + 0.15 * complexity_hit if complexity_hit > 0 else 0.2),
            "rationale": "Complexity terms found." if complexity_hit > 0 else "No complexity analysis detected.",
        },
        {
            "id": "edgeCases",
            "score": _clamp(0.5 + 0.15 * edge_hit if edge_hit > 0 else 0.2),
            "rationale": "Edge-case terms found." if edge_hit > 0 else "No edge cases detected.",
        },
        {
            "id": "codeQuality",
            "score": _clamp(code_quality),
            "rationale": code_rationale,
        },
        {
            "id": "communication",
            "score": _clamp(min(0.9, 0.3 + words / 120)),
            "rationale": "Explanation length/structure proxy.",
        },
    ]
    for entry in rubric:
        entry["label"] = RUBRIC_LABELS[entry["id"]]
    by_id = {entry["id"]: entry for entry in rubric}

    confidence = round2(0.55 + 0.25 * min(1, words / 80))
    covered_ids = {id(item) for item in coverage.covered}
    by_skill: dict[str, dict[str, Any]] = {}
    for item in concepts:
        bucket = by_skill.setdefault(
            str(item["skillId"]), {"total": 0, "covered": 0, "names": [], "missed": []}
        )
        bucket["total"] += 1
        if id(item) in covered_ids:
            bucket["covered"] += 1
            bucket["names"].append(item["concept"])
        else:
            bucket["missed"].append(item["concept"])
    by_skill.setdefault(question_skill_id, {"total": 0, "covered": 0, "names": [], "missed": []})

    scores = []
    for skill_id, bucket in by_skill.items():
        if skill_id == question_skill_id:
            score = round2(0.15 + 0.8 * ratio)
        else:
            denominator = ratio if bucket["total"] == 0 else bucket["covered"] / bucket["total"]
            score = round2(0.15 + 0.8 * denominator)
        scores.append({"skill": skill_id, "score": score, "confidence": confidence})

    complexity_score = by_id["complexity"]["score"]
    edge_score = by_id["edgeCases"]["score"]
    scores.append({"skill": "coding.complexity", "score": complexity_score, "confidence": confidence})
    scores.append({"skill": "coding.edge-cases", "score": edge_score, "confidence": confidence})

    weaknesses = [
        {
            "skill": skill,
            "severity": "high" if bucket["covered"] / bucket["total"] < 0.25 else "medium",
            "evidence": f"Did not address: {', '.join(bucket['missed'])}",
        }
        for skill, bucket in by_skill.items()
        if bucket["total"] > 0 and bucket["covered"] / bucket["total"] < 0.5
    ]
    if complexity_score < 0.6:
        weaknesses.append(
            {
                "skill": "coding.complexity",
                "severity": "medium",
                "evidence": "No clear time/space complexity analysis",
            }
        )
    if edge_score < 0.6:
        weaknesses.append(
            {"skill": "coding.edge-cases", "severity": "medium", "evidence": "Edge cases not discussed"}
        )

    missing = [
        *[item["concept"] for item in coverage.missing],
        *(["Complexity analysis"] if complexity_score < 0.6 else []),
        *(["Edge cases"] if edge_score < 0.6 else []),
    ]

    submitted = (
        f"; submitted {code_len} chars of {language if language is not None else 'code'}"
        if code
        else ""
    )
    return {
        "summary": (
            f"Covered {len(coverage.covered)} of {len(concepts)} expected concepts "
            f"({js_round(ratio * 100)}%){submitted}."
        ),
        "dimensions": {
            "correctness": {"score": by_id["correctness"]["score"], "rationale": "deterministic mock evaluation"},
            "technicalDepth": {"score": _clamp(0.2 + 0.7 * ratio), "rationale": "deterministic mock evaluation"},
            "reasoning": {"score": _clamp(0.25 + 0.5 * ratio), "rationale": "deterministic mock evaluation"},
            "structure": {"score": _clamp(min(0.9, 0.3 + words / 200)), "rationale": "deterministic mock evaluation"},
            "communication": {"score": by_id["communication"]["score"], "rationale": "deterministic mock evaluation"},
            "evidence": {"score": _clamp(0.2 + 0.6 * ratio), "rationale": "deterministic mock evaluation"},
            "roleRelevance": {"score": _clamp(0.4 + 0.4 * ratio), "rationale": "deterministic mock evaluation"},
        },
        "strengths": [
            {"skill": skill, "evidence": f"Explained {', '.join(bucket['names'])}"}
            for skill, bucket in by_skill.items()
            if bucket["total"] > 0 and bucket["covered"] / bucket["total"] >= 0.75
        ],
        "weaknesses": weaknesses,
        "scores": scores,
        "missingConcepts": missing,
        "star": None,
        "rubric": rubric,
        "designUpdates": None,
        "betterApproach": (
            "The answer covered the expected ground."
            if not coverage.missing
            else f"A stronger answer would cover: {', '.join(item['concept'] for item in coverage.missing)}."
        ),
        "followUpTopics": [item["concept"] for item in coverage.missing],
    }


def _text_node(text: str) -> dict[str, Any]:
    return {"type": "text", "text": str(text)[:500]}


def _problem_panel(problem: object) -> dict[str, Any]:
    if isinstance(problem, str):
        return {"type": "card", "title": "Problem", "children": [_text_node(problem)]}
    data: dict[str, Any] = problem if isinstance(problem, dict) else {}
    title = data.get("title")
    statement = data.get("statement")
    if not isinstance(title, str) and not isinstance(statement, str):
        return {
            "type": "emptyState",
            "title": "Problem",
            "description": "The problem will appear here.",
        }
    children: list[dict[str, Any]] = []
    if isinstance(statement, str):
        children.append(_text_node(statement))
    raw_constraints = data.get("constraints")
    constraints = (
        [item for item in raw_constraints if isinstance(item, str)][:10]
        if isinstance(raw_constraints, list)
        else []
    )
    if constraints:
        children.append({"type": "list", "items": [{"text": item[:300]} for item in constraints]})
    raw_examples = data.get("examples")
    examples = raw_examples[:5] if isinstance(raw_examples, list) else []
    for example in examples:
        entry: dict[str, Any] = example if isinstance(example, dict) else {}
        rendered = (
            f"Input: {entry.get('input') if entry.get('input') is not None else ''}"
            f" → Output: {entry.get('output') if entry.get('output') is not None else ''}"
        )
        if entry.get("explanation"):
            rendered += f" — {entry['explanation']}"
        children.append(_text_node(rendered))
    return {
        "type": "card",
        "title": str(title if title is not None else "Problem")[:200],
        "subtitle": "Coding problem",
        "children": children,
    }


class CodingMode:
    """`hook` middleware: `mode.mock` + `ui.render` for the coding round."""

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse | None:
        if req.task == "interviewer":
            return ModeMockResponse(output=_interviewer_output(req.input))
        return ModeMockResponse(output=_evaluator_output(req.input))

    async def ui_render(self, req: UiRenderRequest) -> UiRenderResponse | None:
        if req.component != "coding-problem":
            return UiRenderResponse(ui={"type": "emptyState", "title": "Unknown component"})
        params = req.params if isinstance(req.params, dict) else {}
        extra = params.get("extra")
        problem = extra.get("problem") if isinstance(extra, dict) else None
        return UiRenderResponse(ui=_problem_panel(problem))


def setup(ctx: PluginContext) -> None:
    ctx.middleware(CodingMode())
