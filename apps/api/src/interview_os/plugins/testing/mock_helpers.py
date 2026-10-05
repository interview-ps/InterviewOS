"""Deterministic mock-interview helpers — port of `plugin-sdk/src/mock-helpers.ts`.

Shared by the host's own mock handlers (`skills.mock`) and, from phase 7 on, by
interview-mode plugins, so it stays free of runtime and taxonomy imports:
taxonomy lookups are parameterized — the host injects `skillKeywords` for
interviewer mock tasks and the parent skill id is the plain string prefix.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import TypedDict, cast

from ...core.js_compat import js_round

__all__ = [
    "GENERIC_PROMPTS",
    "MOCK_QUESTION_TEMPLATES",
    "STAR_PARTS",
    "ConceptTemplate",
    "Coverage",
    "ExpectedConcept",
    "GenericPrompt",
    "StarPart",
    "concept",
    "concept_covered",
    "coverage_of",
    "follow_up_mock_output",
    "generic_evaluation_mock",
    "generic_interviewer_mock",
    "in_subtree",
    "keywords_hit",
    "parent_skill_id",
    "pick_question",
    "round2",
    "star_from",
]


def round2(n: float) -> float:
    return js_round(n * 100) / 100


def _object_list(value: object) -> list[object]:
    if isinstance(value, list | tuple):
        return list(value)
    return []


@dataclass(frozen=True, slots=True)
class StarPart:
    name: str
    key: str
    pattern: re.Pattern[str]


# §8.4 STAR detection heuristics reused by the behavioral/hr mode mocks.
STAR_PARTS: tuple[StarPart, ...] = (
    StarPart(
        "Situation",
        "situation",
        re.compile(r"when i|at my (previous|last)|in 20\d\d|our team was", re.I),
    ),
    StarPart(
        "Task",
        "task",
        re.compile(r"my (goal|task|responsibility)|i was (responsible|asked)|needed to", re.I),
    ),
    StarPart(
        "Action",
        "action",
        re.compile(
            r"\bi (led|built|implemented|decided|proposed|organized|wrote|designed|talked)", re.I
        ),
    ),
    StarPart(
        "Result",
        "result",
        re.compile(r"result|reduced|increased|improved|saved|\d+%|shipped|launched", re.I),
    ),
)


class ExpectedConcept(TypedDict):
    concept: str
    skillId: str
    keywords: list[str]


@dataclass(frozen=True, slots=True)
class ConceptTemplate:
    text: str
    topic: str
    sub_skills: tuple[str, ...]
    expected_concepts: tuple[ExpectedConcept, ...]
    difficulty: str


def concept(name: str, skill_id: str, keywords: list[str]) -> ExpectedConcept:
    return {"concept": name, "skillId": skill_id, "keywords": keywords}


def concept_covered(concept_: ExpectedConcept, answer: str) -> bool:
    keys = concept_["keywords"] or [concept_["concept"]]
    lower = answer.lower()
    return any(key.lower() in lower for key in keys)


@dataclass(frozen=True, slots=True)
class Coverage:
    covered: tuple[ExpectedConcept, ...]
    missing: tuple[ExpectedConcept, ...]
    ratio: float


def coverage_of(concepts: Sequence[ExpectedConcept], answer: str) -> Coverage:
    covered = tuple(item for item in concepts if concept_covered(item, answer))
    missing = tuple(item for item in concepts if not concept_covered(item, answer))
    return Coverage(
        covered=covered,
        missing=missing,
        ratio=0.5 if not concepts else len(covered) / len(concepts),
    )


def keywords_hit(answer: str, keywords: Sequence[str]) -> int:
    lower = answer.lower()
    return sum(1 for keyword in keywords if keyword.lower() in lower)


def in_subtree(skill_id: str, root: str) -> bool:
    """Pure string subtree check — mirrors core's `in_subtree`."""

    return skill_id == root or skill_id.startswith(f"{root}.")


def parent_skill_id(skill_id: str) -> str | None:
    """Dot-separated parent id ("coding.algorithms" → "coding"), null for roots."""

    index = skill_id.rfind(".")
    return None if index == -1 else skill_id[:index]


GenericPrompt = Callable[[str], str]

# Well-formed generic prompts when a skill has no dedicated template.
GENERIC_PROMPTS: tuple[GenericPrompt, ...] = (
    lambda label: (
        f"Walk me through a real project where you applied {label}. What trade-offs did you make?"
    ),
    lambda label: f"Tell me about a time {label} mattered in your work — what was hard about it?",
    lambda label: (
        f"Looking back at your experience with {label}, what would you do differently today?"
    ),
)


def _generic_templates(
    skill_id: str,
    label: str,
    generic_prompts: Sequence[GenericPrompt],
    skill_keywords: Sequence[str],
) -> tuple[ConceptTemplate, ...]:
    return tuple(
        ConceptTemplate(
            text=prompt(label),
            topic=label,
            sub_skills=(),
            expected_concepts=tuple(
                concept(keyword, skill_id, [keyword.split(" ")[0]])
                for keyword in list(skill_keywords)[:3]
            ),
            difficulty="medium",
        )
        for prompt in generic_prompts
    )


def pick_question(
    templates: dict[str, tuple[ConceptTemplate, ...]],
    skill_id: str,
    label: str,
    previous_questions: Sequence[str],
    generic_prompts: Sequence[GenericPrompt] = GENERIC_PROMPTS,
    skill_keywords: Sequence[str] = (),
) -> tuple[ConceptTemplate, str]:
    """Pick the first unasked template for a skill (falling back to the skill's
    parent or generic prompts), adding a "(variant N)" suffix when exhausted.
    """

    asked = set(previous_questions)
    options = templates.get(skill_id)
    if options is None:
        options = templates.get(parent_skill_id(skill_id) or "")
    if options is None:
        options = _generic_templates(skill_id, label, generic_prompts, skill_keywords)

    chosen = next((template for template in options if template.text not in asked), None)
    if chosen is not None:
        return chosen, chosen.text
    template = options[0]
    n = 2
    while f"{template.text} (variant {n})" in asked:
        n += 1
    return template, f"{template.text} (variant {n})"


def follow_up_mock_output(skill_id: str, focus: str, mode: str) -> dict[str, object]:
    """§9.1 mock follow-up: a deeper probe on the parent's focus, same skill."""

    if mode == "behavioral":
        phrasing = f"Let's stay with that story — {focus}: tell me more about that part."
    elif mode == "hr":
        phrasing = f"I'd like to dig into {focus} a bit more — can you expand?"
    else:
        phrasing = f"Let's go deeper on {focus}: walk me through the specifics and the trade-offs."
    return {
        "question": phrasing,
        "topic": f"Follow-up: {focus}",
        "skillId": skill_id,
        "subSkills": [],
        "expectedConcepts": [concept(focus, skill_id, focus.split(" "))],
        "difficulty": "medium",
        "problem": None,
        "focusDimension": None,
    }


def star_from(answer: str) -> dict[str, object]:
    """Derive the {situation,task,action,result} STAR object used by mode evaluator mocks."""

    return {
        **{part.key: part.pattern.search(answer) is not None for part in STAR_PARTS},
        "notes": "",
    }


def _template(
    text: str,
    topic: str,
    sub_skills: tuple[str, ...],
    expected_concepts: tuple[ExpectedConcept, ...],
    difficulty: str,
) -> ConceptTemplate:
    return ConceptTemplate(
        text=text,
        topic=topic,
        sub_skills=sub_skills,
        expected_concepts=expected_concepts,
        difficulty=difficulty,
    )


MOCK_QUESTION_TEMPLATES: dict[str, tuple[ConceptTemplate, ...]] = {
    "distributed-systems.caching": (
        _template(
            "How would you keep cache entries consistent with the database when the underlying data changes?",
            "Cache consistency",
            (
                "distributed-systems.caching.cache-strategies",
                "distributed-systems.caching.cache-invalidation",
            ),
            (
                concept(
                    "cache-aside / read-through",
                    "distributed-systems.caching.cache-strategies",
                    ["cache-aside", "read-through", "lazy load"],
                ),
                concept(
                    "TTL / expiration",
                    "distributed-systems.caching.cache-invalidation",
                    ["ttl", "expir"],
                ),
                concept(
                    "explicit invalidation on write",
                    "distributed-systems.caching.cache-invalidation",
                    ["invalidat", "delete the key", "evict"],
                ),
                concept(
                    "write-through / write-behind trade-offs",
                    "distributed-systems.caching.cache-invalidation",
                    ["write-through", "write-behind", "write-back"],
                ),
                concept(
                    "stale reads / race conditions",
                    "distributed-systems.consistency",
                    ["stale", "race", "consisten"],
                ),
            ),
            "medium",
        ),
        _template(
            "A product page is read 10k times a second and rarely changes. Walk me through the caching layer you would put in front of it.",
            "Caching design",
            ("distributed-systems.caching.cache-strategies",),
            (
                concept(
                    "cache-aside vs read-through",
                    "distributed-systems.caching.cache-strategies",
                    ["cache-aside", "read-through"],
                ),
                concept(
                    "TTL choice", "distributed-systems.caching.cache-invalidation", ["ttl", "expir"]
                ),
                concept(
                    "stampede / hot key protection",
                    "distributed-systems.caching",
                    ["stampede", "thundering herd", "hot key"],
                ),
            ),
            "medium",
        ),
        _template(
            "How do you size and shard a Redis cluster when the working set outgrows one machine?",
            "Cache scaling",
            ("distributed-systems.partitioning",),
            (
                concept(
                    "sharding / partitioning",
                    "distributed-systems.partitioning",
                    ["shard", "partition", "consistent hashing"],
                ),
                concept("eviction policy", "distributed-systems.caching", ["evict", "lru", "lfu"]),
                concept(
                    "replication for reads",
                    "distributed-systems.replication",
                    ["replica", "replication"],
                ),
            ),
            "hard",
        ),
    ),
    "distributed-systems.caching.cache-invalidation": (
        _template(
            "Compare TTL-based expiry with explicit invalidation for a product-catalog cache — when would you choose each, and what can go wrong?",
            "Cache invalidation strategies",
            ("distributed-systems.caching.cache-strategies",),
            (
                concept(
                    "TTL expiry semantics",
                    "distributed-systems.caching.cache-invalidation",
                    ["ttl", "expir"],
                ),
                concept(
                    "explicit invalidation",
                    "distributed-systems.caching.cache-invalidation",
                    ["invalidat", "delete the key", "evict"],
                ),
                concept(
                    "write-through / write-behind",
                    "distributed-systems.caching.cache-invalidation",
                    ["write-through", "write-behind", "write-back"],
                ),
                concept(
                    "stale-read window", "distributed-systems.consistency", ["stale", "consisten"]
                ),
            ),
            "medium",
        ),
        _template(
            "Your cache shows stale prices after a database update. Walk me through how you debug and fix the invalidation path.",
            "Stale-cache debugging",
            ("distributed-systems.caching.cache-strategies",),
            (
                concept(
                    "write-path invalidation",
                    "distributed-systems.caching.cache-invalidation",
                    ["invalidat", "evict", "delete the key"],
                ),
                concept(
                    "event/version-based expiry",
                    "distributed-systems.caching.cache-invalidation",
                    ["version", "event", "ttl"],
                ),
            ),
            "hard",
        ),
    ),
    "distributed-systems.caching.cache-strategies": (
        _template(
            "Explain the difference between cache-aside, read-through and write-through caching. Which would you pick for a low-latency read path and why?",
            "Cache strategies",
            (),
            (
                concept(
                    "cache-aside", "distributed-systems.caching.cache-strategies", ["cache-aside"]
                ),
                concept(
                    "read-through", "distributed-systems.caching.cache-strategies", ["read-through"]
                ),
                concept(
                    "write-through / write-behind",
                    "distributed-systems.caching.cache-invalidation",
                    ["write-through", "write-behind"],
                ),
            ),
            "medium",
        ),
    ),
    "distributed-systems.message-queues": (
        _template(
            "You need to send order confirmations reliably. Design the producer/queue/consumer flow and tell me how you handle failures.",
            "Message queues",
            (),
            (
                concept(
                    "at-least-once vs exactly-once",
                    "distributed-systems.message-queues",
                    ["at-least-once", "exactly-once", "idempoten"],
                ),
                concept(
                    "dead-letter / poison messages",
                    "distributed-systems.message-queues",
                    ["dead-letter", "poison", "dlq"],
                ),
                concept(
                    "backpressure", "distributed-systems.message-queues", ["backpressure", "lag"]
                ),
            ),
            "medium",
        ),
    ),
    "distributed-systems": (
        _template(
            "What breaks first when you split a monolith into services? Give me a concrete example.",
            "Distributed systems fundamentals",
            (),
            (
                concept(
                    "partial failure",
                    "distributed-systems",
                    ["partial failure", "timeout", "retry"],
                ),
                concept(
                    "consistency trade-offs",
                    "distributed-systems.consistency",
                    ["consisten", "eventual"],
                ),
            ),
            "medium",
        ),
    ),
    "system-design": (
        _template(
            "Design a URL shortener. Start with the requirements you would clarify, then walk me through the high-level design.",
            "System design: URL shortener",
            ("system-design.requirements-analysis", "system-design.scalability"),
            (
                concept(
                    "requirements clarification",
                    "system-design.requirements-analysis",
                    ["requirement", "clarif", "scope"],
                ),
                concept(
                    "capacity estimation",
                    "system-design.capacity-estimation",
                    ["qps", "estimate", "storage"],
                ),
                concept(
                    "scaling the reads",
                    "system-design.scalability",
                    ["cache", "load balanc", "scale"],
                ),
            ),
            "medium",
        ),
        _template(
            "Design a rate limiter as a shared service for multiple internal APIs.",
            "System design: rate limiter",
            ("system-design.scalability",),
            (
                concept(
                    "token bucket / sliding window",
                    "system-design",
                    ["token bucket", "sliding window", "fixed window"],
                ),
                concept(
                    "distributed counter store", "distributed-systems", ["redis", "distributed"]
                ),
            ),
            "hard",
        ),
    ),
    "system-design.scalability": (
        _template(
            "Your API latency doubles every time traffic doubles. Where do you look first?",
            "Scalability",
            (),
            (
                concept(
                    "bottleneck analysis",
                    "system-design.scalability",
                    ["bottleneck", "profil", "metric"],
                ),
                concept(
                    "horizontal scaling",
                    "system-design.scalability",
                    ["horizontal", "scale out", "load balanc"],
                ),
            ),
            "medium",
        ),
    ),
    "sql": (
        _template(
            "A reporting query that joins three tables went from 50ms to 8s. How do you approach it?",
            "SQL query optimization",
            ("sql.query-optimization", "sql.indexing"),
            (
                concept("query plan", "sql.query-optimization", ["explain", "query plan", "plan"]),
                concept("indexing", "sql.indexing", ["index"]),
                concept(
                    "row estimates / statistics",
                    "sql.query-optimization",
                    ["statistic", "estimate", "cardinality"],
                ),
            ),
            "medium",
        ),
    ),
    "python": (
        _template(
            "Tell me about a Python performance problem you solved — what did you measure and what did you change?",
            "Python in practice",
            (),
            (
                concept("profiling/measurement", "python", ["profil", "measure", "benchmark"]),
                concept("concrete fix", "python", ["async", "cache", "vectoriz", "multiprocess"]),
            ),
            "easy",
        ),
    ),
    "apis": (
        _template(
            "Design the REST endpoints for a small order-management API — walk me through resources, methods and status codes.",
            "REST API design",
            ("apis.rest",),
            (
                concept("resource modeling", "apis.rest", ["resource", "endpoint", "/orders"]),
                concept("idempotency", "apis.rest", ["idempoten"]),
                concept("status codes", "apis.rest", ["200", "201", "404", "status"]),
            ),
            "easy",
        ),
    ),
    "behavioral": (
        _template(
            "Tell me about a time you disagreed with a teammate on a technical approach. What happened?",
            "Conflict",
            ("behavioral.conflict",),
            (
                concept(
                    "Situation context", "communication", ["when i", "at my", "our team", "we were"]
                ),
                concept(
                    "Your specific actions",
                    "communication",
                    ["i led", "i decided", "i proposed", "i talked", "i wrote"],
                ),
                concept(
                    "Measurable result",
                    "communication",
                    ["result", "outcome", "%", "reduced", "improved", "shipped"],
                ),
            ),
            "easy",
        ),
    ),
    "behavioral.conflict": (
        _template(
            "Tell me about a specific time you disagreed with a teammate or your manager. Walk me through what you did and how it ended.",
            "Conflict",
            (),
            (
                concept(
                    "Situation context", "communication", ["when i", "at my", "our team", "we were"]
                ),
                concept(
                    "The disagreement", "behavioral.conflict", ["disagree", "conflict", "pushback"]
                ),
                concept(
                    "Your specific actions",
                    "communication",
                    ["i led", "i decided", "i proposed", "i talked"],
                ),
                concept(
                    "Measurable result", "communication", ["result", "outcome", "%", "resolved"]
                ),
            ),
            "easy",
        ),
    ),
    "behavioral.ownership": (
        _template(
            "Tell me about a time you took ownership of a problem that wasn't strictly yours. What did you do?",
            "Ownership",
            (),
            (
                concept(
                    "Situation context", "communication", ["when i", "at my", "our team", "we were"]
                ),
                concept(
                    "Your specific actions",
                    "communication",
                    ["i led", "i decided", "i built", "i organized", "i drove"],
                ),
                concept(
                    "Measurable result",
                    "communication",
                    ["result", "%", "reduced", "improved", "shipped"],
                ),
            ),
            "easy",
        ),
    ),
    "behavioral.failure-learning": (
        _template(
            "Tell me about a time something you were responsible for failed. What did you do and what did you learn?",
            "Learning from failure",
            (),
            (
                concept(
                    "Situation context", "communication", ["when i", "at my", "our team", "we were"]
                ),
                concept(
                    "What went wrong",
                    "behavioral.failure-learning",
                    ["fail", "broke", "outage", "mistake"],
                ),
                concept(
                    "Your specific actions",
                    "communication",
                    ["i led", "i decided", "i implemented", "i wrote"],
                ),
                concept(
                    "What changed after",
                    "behavioral.failure-learning",
                    ["learned", "after that", "now we", "postmortem"],
                ),
            ),
            "medium",
        ),
    ),
    "behavioral.collaboration": (
        _template(
            "Describe a time you worked closely with another team or function to ship something. What was your role?",
            "Collaboration",
            (),
            (
                concept(
                    "Situation context", "communication", ["when i", "at my", "our team", "we were"]
                ),
                concept(
                    "Who you worked with",
                    "behavioral.collaboration",
                    ["product", "design", "team", "stakeholder", "partner"],
                ),
                concept(
                    "Your specific actions",
                    "communication",
                    ["i led", "i organized", "i proposed", "i built"],
                ),
                concept(
                    "Measurable result", "communication", ["result", "%", "shipped", "launched"]
                ),
            ),
            "easy",
        ),
    ),
    "behavioral.leadership": (
        _template(
            "Tell me about a time you led without formal authority — how did you get people on board?",
            "Leadership",
            (),
            (
                concept(
                    "Situation context", "communication", ["when i", "at my", "our team", "we were"]
                ),
                concept(
                    "Your specific actions",
                    "communication",
                    ["i led", "i proposed", "i convinced", "i organized"],
                ),
                concept(
                    "Measurable result",
                    "communication",
                    ["result", "%", "adopted", "shipped", "decided"],
                ),
            ),
            "medium",
        ),
    ),
    "hr": (
        _template(
            "What draws you to this role, and where do you want to grow next?",
            "Motivation & growth",
            ("hr.motivation", "hr.career-goals"),
            (
                concept(
                    "Genuine motivation",
                    "hr.motivation",
                    ["excited", "motivated", "interested", "drawn"],
                ),
                concept("Career direction", "hr.career-goals", ["grow", "goal", "next", "learn"]),
                concept("Mutual fit", "hr.culture-fit", ["team", "culture", "value"]),
            ),
            "easy",
        ),
    ),
    "hr.motivation": (
        _template(
            "Why this role, and why our company specifically?",
            "Motivation",
            (),
            (
                concept(
                    "Specific interest in the role",
                    "hr.motivation",
                    ["role", "excited", "interested", "motivated"],
                ),
                concept(
                    "Knowledge of the company",
                    "hr.motivation",
                    ["your", "company", "product", "mission", "values"],
                ),
                concept(
                    "What you bring", "hr.motivation", ["experience", "skills", "i've", "i have"]
                ),
            ),
            "easy",
        ),
    ),
    "hr.career-goals": (
        _template(
            "Where do you want your career to go over the next few years, and how does this role fit?",
            "Career goals",
            (),
            (
                concept(
                    "A direction, not a title",
                    "hr.career-goals",
                    ["grow", "learn", "lead", "deepen", "goal"],
                ),
                concept(
                    "Fit with this role", "hr.career-goals", ["this role", "here", "opportunity"]
                ),
            ),
            "easy",
        ),
    ),
    "hr.culture-fit": (
        _template(
            "What kind of team culture brings out your best work, and what kind drains you?",
            "Culture fit",
            (),
            (
                concept(
                    "Concrete culture traits",
                    "hr.culture-fit",
                    ["culture", "feedback", "autonomy", "collaboration", "transparent"],
                ),
                concept(
                    "Self-awareness",
                    "hr.culture-fit",
                    ["i work best", "i need", "i prefer", "thrive"],
                ),
            ),
            "easy",
        ),
    ),
    "hr.work-style": (
        _template(
            "How do you like to work day to day — how do you communicate, take feedback, and manage your time?",
            "Work style",
            (),
            (
                concept(
                    "Concrete work habits",
                    "hr.work-style",
                    ["i prefer", "i usually", "async", "standup", "feedback"],
                ),
                concept(
                    "Collaboration style",
                    "hr.work-style",
                    ["pair", "review", "communicate", "slack", "docs"],
                ),
            ),
            "easy",
        ),
    ),
}

TEMPLATES = MOCK_QUESTION_TEMPLATES


def generic_interviewer_mock(input: object) -> object:
    """The deterministic "ask a question" mock shared by the host's `interviewer`
    task and mode plugins. Skill-specific templates first, then parent, then
    generic prompts seeded with the skill's keywords.
    """

    data: dict[str, object] = input if isinstance(input, dict) else {}
    skill_id = str(data.get("skillId", ""))
    label = str(data.get("label", ""))
    previous_questions = [str(item) for item in _object_list(data.get("previousQuestions"))]
    seed_question = data.get("seedQuestion")
    external_context = data.get("externalContext")
    skill_keywords = [str(item) for item in _object_list(data.get("skillKeywords"))]

    # v0.4: a stored external context grounds the question (references its title)
    if isinstance(external_context, dict) and external_context.get("title"):
        return {
            "question": (
                f"Looking at {external_context['title']}, how would you describe its "
                f"{label.lower()} approach, and what would you change?"
            ),
            "topic": label,
            "skillId": skill_id,
            "subSkills": [],
            "expectedConcepts": [concept(label, skill_id, [])],
            "difficulty": "medium",
        }
    # a question-source suggestion is used verbatim (the orchestrator picked it)
    if isinstance(seed_question, dict) and seed_question.get("text"):
        suggestions = _object_list(seed_question.get("expectedConcepts"))
        return {
            "question": seed_question["text"],
            "topic": label,
            "skillId": skill_id,
            "subSkills": [],
            "expectedConcepts": [concept(str(item), skill_id, []) for item in suggestions],
            "difficulty": "medium",
        }
    template, rendered = pick_question(
        MOCK_QUESTION_TEMPLATES,
        skill_id,
        label,
        previous_questions,
        GENERIC_PROMPTS,
        skill_keywords,
    )
    return {
        "question": rendered,
        "topic": template.topic,
        "skillId": skill_id,
        "subSkills": list(template.sub_skills),
        "expectedConcepts": [dict(item) for item in template.expected_concepts],
        "difficulty": template.difficulty,
    }


@dataclass
class _SkillBucket:
    total: int = 0
    covered: int = 0
    names: list[str] = field(default_factory=list)
    missed: list[str] = field(default_factory=list)


def generic_evaluation_mock(input: object) -> object:
    """The deterministic "score an answer" mock shared by the host's
    `answer-evaluator` task and mode plugins. STAR applies to behavioral/
    communication/hr territory — by round type or by skill subtree.
    """

    data: dict[str, object] = input if isinstance(input, dict) else {}
    raw_question = data.get("question")
    question: dict[str, object] = raw_question if isinstance(raw_question, dict) else {}
    answer = str(data.get("answer", ""))
    round_type = str(data.get("roundType") or "mixed")
    concepts: list[ExpectedConcept] = [
        cast("ExpectedConcept", item)
        for item in _object_list(question.get("expectedConcepts"))
        if isinstance(item, dict)
    ]
    question_skill_id = str(question.get("skillId", ""))

    # §8.4: STAR applies to behavioral/hr questions (round type or skill subtree).
    star_relevant = (
        round_type in ("behavioral", "hr")
        or in_subtree(question_skill_id, "behavioral")
        or in_subtree(question_skill_id, "communication")
        or in_subtree(question_skill_id, "hr")
    )
    star_hits = [
        (part, star_relevant and part.pattern.search(answer) is not None) for part in STAR_PARTS
    ]
    missing_star = [part for part, hit in star_hits if not hit] if star_relevant else []
    star = (
        {
            "situation": star_hits[0][1],
            "task": star_hits[1][1],
            "action": star_hits[2][1],
            "result": star_hits[3][1],
            "notes": (
                "All four STAR parts are present."
                if not missing_star
                else f"Missing: {', '.join(part.name for part in missing_star)}"
            ),
        }
        if star_relevant
        else None
    )
    words = len([word for word in answer.strip().split() if word])
    sentences = len([sentence for sentence in re.split(r"[.!?]+", answer) if sentence.strip()])

    covered = [item for item in concepts if concept_covered(item, answer)]
    missing = [item for item in concepts if not concept_covered(item, answer)]
    overall_coverage = 0.5 if not concepts else len(covered) / len(concepts)

    confidence = round2(0.55 + 0.25 * min(1, words / 80))

    by_skill: dict[str, _SkillBucket] = {}

    def bucket(skill_id: str) -> _SkillBucket:
        return by_skill.setdefault(skill_id, _SkillBucket())

    for item in concepts:
        entry = bucket(item["skillId"])
        entry.total += 1
        if concept_covered(item, answer):
            entry.covered += 1
            entry.names.append(item["concept"])
        else:
            entry.missed.append(item["concept"])
    bucket(question_skill_id)

    # STAR coverage feeds the communication score for behavioral/hr answers.
    if star_relevant:
        communication = bucket("communication")
        for part, hit in star_hits:
            communication.total += 1
            if hit:
                communication.covered += 1
            else:
                communication.missed.append(f"STAR {part.name}")

    scores = [
        {
            "skill": skill_id,
            "score": round2(
                0.15 + 0.8 * overall_coverage
                if skill_id == question_skill_id
                else 0.15
                + 0.8 * (overall_coverage if entry.total == 0 else entry.covered / entry.total)
            ),
            "confidence": confidence,
        }
        for skill_id, entry in by_skill.items()
    ]

    strengths = [
        {"skill": skill_id, "evidence": f"Explained {', '.join(entry.names)}"}
        for skill_id, entry in by_skill.items()
        if entry.total > 0 and entry.covered / entry.total >= 0.75
    ]
    weaknesses = [
        {
            "skill": skill_id,
            "severity": "high" if entry.covered / entry.total < 0.25 else "medium",
            "evidence": f"Did not address: {', '.join(entry.missed)}",
        }
        for skill_id, entry in by_skill.items()
        if entry.total > 0
        and entry.covered / entry.total < 0.5
        and not (star_relevant and skill_id == "communication")
    ]
    if missing_star:
        weaknesses.append(
            {
                "skill": "communication",
                "severity": "medium",
                "evidence": f"Answer lacked a clear {', '.join(part.name for part in missing_star)}",
            }
        )

    def dim(base: float) -> dict[str, object]:
        return {"score": round2(min(1, max(0, base))), "rationale": "deterministic mock evaluation"}

    return {
        "summary": (
            f"Covered {len(covered)} of {len(concepts)} expected concepts "
            f"({js_round(overall_coverage * 100)}%)."
        ),
        "dimensions": {
            "correctness": dim(0.3 + 0.6 * overall_coverage),
            "technicalDepth": dim(0.2 + 0.7 * overall_coverage),
            "reasoning": dim(0.25 + 0.5 * overall_coverage + min(0.15, sentences * 0.03)),
            "structure": dim(min(0.9, 0.3 + sentences * 0.1)),
            "communication": dim(min(0.9, 0.3 + words / 120)),
            "evidence": dim(0.2 + 0.6 * overall_coverage),
            "roleRelevance": dim(0.4 + 0.4 * overall_coverage),
        },
        "strengths": strengths,
        "weaknesses": weaknesses,
        "scores": scores,
        "missingConcepts": [
            *[item["concept"] for item in missing],
            *[f"STAR {part.name}" for part in missing_star],
        ],
        "star": star,
        "betterApproach": (
            "The answer covered the expected ground."
            if not missing
            else f"A stronger answer would cover: {', '.join(item['concept'] for item in missing)}."
        ),
        "followUpTopics": [item["concept"] for item in missing],
    }
