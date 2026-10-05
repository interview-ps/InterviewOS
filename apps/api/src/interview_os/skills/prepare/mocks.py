"""Prepare-skill mock handlers — ports of `skills/prepare/*/mock.ts`."""

from __future__ import annotations

import re

from ...core import taxonomy

__all__ = [
    "prep_planner_mock",
    "resume_coach_bullets_mock",
    "resume_coach_tailor_mock",
    "star_coach_generate_mock",
    "star_coach_review_mock",
]

_PLACEHOLDER = re.compile(r"^\s*$|\[add\b", re.I)
_MARKER = re.compile(r"^\s*(?:[-*•‣◦]|\d+\.)\s*")
_NAMED_BULLET = re.compile(r"^([A-Z][\w+.@-]*)\s+[—–-]\s+(.+)$")
_ROLE_COMPANY = re.compile(
    r"^(.{0,120}?)\s{1,4}[—–-]\s{1,4}(.{0,80}?)\s{1,4}[—–-]\s{1,4}(.{0,200})$"
)
_LEAD_IN = re.compile(r"^(responsible for|worked on|helped with)\s+", re.I)

_ACTION_VERBS = frozenset(
    """
    accelerated achieved analyzed analysed architected automated built coached
    collaborated consolidated coordinated created cut debugged decreased delivered
    designed developed directed doubled drove enabled engineered established
    executed expanded founded generated grew headed implemented improved increased
    initiated introduced launched led maintained managed mentored migrated modernized
    modernised negotiated optimized optimised orchestrated owned pioneered produced
    prototyped reduced refactored researched resolved scaled shaped shipped simplified
    spearheaded streamlined strengthened transformed tripled wrote
    """.split()
)

_VERB_FALLBACK = "Delivered"


def _dict(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def _list(value: object) -> list[object]:
    return list(value) if isinstance(value, list | tuple) else []


def _prep_templates() -> dict[str, dict[str, object]]:
    return {
        "distributed-systems.caching.cache-invalidation": {
            "action": (
                "Practice explaining three cache invalidation strategies, then complete "
                "one mock question on them"
            ),
            "successCriteria": [
                "Explain TTL-based expiration",
                "Explain explicit invalidation on writes",
                "Explain write-through/write-behind trade-offs",
                "Complete one mock question covering all three",
            ],
        },
        "distributed-systems.caching": {
            "action": (
                "Design the caching layer for a read-heavy product catalog on a "
                "whiteboard, then explain it aloud"
            ),
            "successCriteria": [
                "Name the caching pattern you chose (cache-aside/read-through/write-through)",
                "Explain how entries expire or get invalidated",
                "Explain what happens on a cache stampede",
            ],
        },
        "distributed-systems.caching.cache-strategies": {
            "action": (
                "Compare cache-aside, read-through and write-through for a concrete "
                "service you know"
            ),
            "successCriteria": [
                "Describe each strategy in one sentence",
                "Give one failure mode for each",
                "Complete one mock question",
            ],
        },
        "distributed-systems.message-queues": {
            "action": (
                "Sketch a producer/consumer design with a queue and explain delivery semantics"
            ),
            "successCriteria": [
                "Explain at-least-once vs exactly-once",
                "Explain how you handle poison messages",
                "Complete one mock question",
            ],
        },
        "distributed-systems": {
            "action": "Outline a microservice architecture you know and list its failure modes",
            "successCriteria": [
                "Name two consistency challenges",
                "Explain one resilience pattern you would add",
            ],
        },
        "system-design": {
            "action": (
                "Practice one full system-design question end-to-end with explicit "
                "clarifying questions"
            ),
            "successCriteria": [
                "Write down functional and non-functional requirements first",
                "Give a back-of-envelope capacity estimate",
                "Draw a high-level component diagram",
            ],
        },
        "sql": {
            "action": (
                "Optimize two slow queries on a real schema: read the query plan, add an index"
            ),
            "successCriteria": [
                "Explain the chosen index",
                "Explain a covering index vs a lookup",
            ],
        },
        "sql.indexing": {
            "action": "Design indexes for three query patterns and explain each choice",
            "successCriteria": [
                "Explain B-tree ordering",
                "Explain composite index column order",
            ],
        },
        "apis": {
            "action": "Design a small REST API surface and document it",
            "successCriteria": [
                "Use consistent resource naming",
                "Choose correct status codes",
            ],
        },
        "behavioral": {
            "action": "Prepare two STAR stories and tell each aloud in under 2 minutes",
            "successCriteria": [
                "One story shows leadership",
                "One story shows handling conflict",
            ],
        },
        "communication": {
            "action": "Rewrite one story with a quantified Result",
            "successCriteria": [
                "Situation in one sentence",
                "Actions in first person",
                "Result with a number",
                "Under 2 minutes",
            ],
        },
    }


def _generic_action(target: dict[str, object]) -> dict[str, object]:
    missing = [str(item) for item in _list(target.get("missingConcepts"))]
    if missing:
        concepts = missing[:3]
    else:
        node = taxonomy.get_node(str(target.get("skillId", "")))
        concepts = list(node.keywords)[:3] if node is not None else []
    label = str(target.get("label") or taxonomy.label_for(str(target.get("skillId", ""))))
    joined = ", ".join(concepts) or "the fundamentals"
    criteria = [f"Explain {concept}" for concept in concepts]
    criteria += ["Explain the key trade-offs", "Complete one mock question on the topic"]
    return {
        "action": (
            f"Practice {label}: prepare a 2-minute explanation covering {joined}, "
            "then answer one mock question on it."
        ),
        "successCriteria": criteria[:4],
    }


def prep_planner_mock(input: object) -> object:
    data = _dict(input)
    targets = [item for item in _list(data.get("targets")) if isinstance(item, dict)]
    templates = _prep_templates()
    actions = []
    for target in targets:
        skill_id = str(target.get("skillId", ""))
        template = templates.get(skill_id) or _generic_action(target)
        actions.append(
            {
                "skillId": skill_id,
                "action": template["action"],
                "successCriteria": template["successCriteria"],
                "reason": target.get("reason"),
            }
        )
    return {"actions": actions}


def _decap(text: str) -> str:
    return text[0].lower() + text[1:] if text else text


def star_coach_generate_mock(input: object) -> object:
    """star-coach.generate: one story per experience bullet (max 4), placeholders for gaps."""
    data = _dict(input)
    experience = [item for item in _list(data.get("experience")) if isinstance(item, dict)]
    achievements = [str(item) for item in _list(data.get("achievements"))]
    projects = [item for item in _list(data.get("projects")) if isinstance(item, dict)]
    behavioral = [str(item) for item in _list(data.get("behavioralSkillIds"))]
    existing = [str(item) for item in _list(data.get("existingTitles"))]
    taken = {title.lower() for title in existing}
    stories: list[dict[str, object]] = []

    def push(title: str, situation: str, task: str, action: str) -> bool:
        if title.lower() in taken:
            return True
        taken.add(title.lower())
        stories.append(
            {
                "title": title,
                "situation": situation,
                "task": task,
                "action": action,
                "result": "[add metric]",
                "skillIds": behavioral[:2],
            }
        )
        return len(stories) < 4

    for experience_item in experience:
        company = str(experience_item.get("company") or "")
        title_text = str(experience_item.get("title") or "")
        for highlight in _list(experience_item.get("highlights")):
            if len(stories) >= 4:
                return {"stories": stories}
            text = str(highlight)
            title = f"{company or title_text}: {text[:60]}"
            keep_going = push(
                title,
                f"[add situation — when/where at {company or 'this role'}]",
                f"[add your goal as {title_text}]",
                f"I {_decap(text)}",
            )
            if not keep_going:
                return {"stories": stories}

    for achievement in achievements:
        if len(stories) >= 4:
            return {"stories": stories}
        keep_going = push(
            f"Achievement: {achievement[:60]}",
            "[add situation — the context for this achievement]",
            "[add your goal]",
            f"I {_decap(achievement)}",
        )
        if not keep_going:
            return {"stories": stories}

    for project in projects:
        if len(stories) >= 4:
            return {"stories": stories}
        name = str(project.get("name") or "")
        description = str(project.get("description") or "")
        keep_going = push(
            f"Project: {name[:60]}",
            f"[add situation — why {name} was needed]",
            "[add your goal]",
            f"I worked on {name}: {description}"[:300],
        )
        if not keep_going:
            return {"stories": stories}
    return {"stories": stories}


def star_coach_review_mock(input: object) -> object:
    """star-coach.review: flag empty/placeholder parts and number-less results."""
    data = _dict(input)
    story = _dict(data.get("story"))
    role = str(data.get("role", ""))
    level = str(data.get("level", ""))
    title = str(story.get("title", ""))

    missing: list[str] = []
    suggestions: list[str] = []
    parts = (
        ("Situation", str(story.get("situation", ""))),
        ("Task", str(story.get("task", ""))),
        ("Action", str(story.get("action", ""))),
        ("Result", str(story.get("result", ""))),
    )
    for name, text in parts:
        if _PLACEHOLDER.search(text):
            missing.append(f"{name} is missing or still a placeholder")
            suggestions.append(f"Write the {name.lower()} in 1–2 concrete sentences")

    result_text = str(story.get("result", ""))
    if result_text.strip() and not re.search(r"\d", result_text):
        missing.append("Result lacks a measurable outcome")
        suggestions.append("Add a number or percentage to the Result (time saved, %, users)")
    if len(result_text.strip().split()) < 6 and not _PLACEHOLDER.search(result_text):
        suggestions.append("Expand the Result beyond a single phrase — what changed and for whom")

    def draft_or_placeholder(text: str, placeholder: str) -> str:
        return placeholder if _PLACEHOLDER.search(text) else text

    improved_draft = {
        "situation": draft_or_placeholder(
            str(story.get("situation", "")),
            "[add situation — one sentence: when, where, what was at stake]",
        ),
        "task": draft_or_placeholder(
            str(story.get("task", "")), "[add task — the goal or responsibility you owned]"
        ),
        "action": draft_or_placeholder(
            str(story.get("action", "")), "[add action — what YOU did, first person]"
        ),
        "result": (
            "[add metric — quantify the outcome: %, time, users, revenue]"
            if _PLACEHOLDER.search(result_text) or not re.search(r"\d", result_text)
            else result_text
        ),
    }

    qualified = role if role.lower().startswith(level) else f"{level} {role}"
    if not missing:
        feedback = (
            f'"{title}" is in good shape for a {qualified} interview — '
            "all four STAR parts are present and grounded."
        )
    else:
        feedback = (
            f'"{title}" needs work for a {qualified} interview: '
            f"{'; '.join(missing)}. Tighten it so each STAR part is concrete."
        )
    return {
        "feedback": feedback,
        "missing": missing,
        "suggestions": suggestions,
        "improvedDraft": improved_draft,
    }


def _strip_marker(bullet: str) -> str:
    return _MARKER.sub("", bullet).strip()


def _first_word_is_verb(text: str) -> bool:
    match = re.match(r"^[A-Za-z]+", text)
    return match is not None and match.group(0).lower() in _ACTION_VERBS


def _rewrite_bullet(bullet: str) -> tuple[str, str]:
    """Deterministic rewrite: keep facts, force an action-verb start + [add metric]."""
    text = _strip_marker(bullet)
    parts: list[str] = []
    improved = text

    role_company = _ROLE_COMPANY.match(text)
    if role_company is not None:
        company = role_company.group(2)
        action = role_company.group(3)
        if _first_word_is_verb(action):
            improved = f"{action[0].upper()}{action[1:]} at {company}"
        else:
            improved = f"{_VERB_FALLBACK} {_LEAD_IN.sub('', action)} at {company}"
        parts.append("moved the employer into the sentence")
    else:
        named = _NAMED_BULLET.match(text)
        if named:
            improved = f"Built {named.group(1)}, {named.group(2)}"
            parts.append("starts with an action verb")
        elif not _first_word_is_verb(text):
            body = _LEAD_IN.sub("", text)
            improved = f"{_VERB_FALLBACK} {body}"
            parts.append("starts with an action verb")
        else:
            improved = text[0].upper() + text[1:]

    if not re.search(r"\d", improved):
        improved = f"{re.sub(r'[.\s]+$', '', improved)}, achieving [add metric]"
        parts.append("adds a measurable outcome placeholder")

    rationale = (
        "Already strong: action verb plus a number."
        if not parts
        else f"Rewritten to be more scannable — {' and '.join(parts)}."
    )
    return improved, rationale


def resume_coach_bullets_mock(input: object) -> object:
    data = _dict(input)
    bullets = [str(item) for item in _list(data.get("bullets"))]
    suggestions = []
    for bullet in bullets:
        improved, rationale = _rewrite_bullet(bullet)
        suggestions.append(
            {
                "original": bullet,
                "improved": improved,
                "rationale": rationale,
                "skillIds": [match.skill_id for match in taxonomy.match_skills(bullet)[:3]],
            }
        )
    return {"suggestions": suggestions}


def resume_coach_tailor_mock(input: object) -> object:
    data = _dict(input)
    resume_text = str(data.get("resumeText", ""))
    requirements = [item for item in _list(data.get("requirements")) if isinstance(item, dict)]
    role = str(data.get("role", ""))
    lines = re.split(r"\r?\n", resume_text)
    matched = {match.skill_id for match in taxonomy.match_skills(resume_text)}

    def is_covered(skill_id: str) -> bool:
        if skill_id in matched:
            return True
        return any(skill_id in taxonomy.ancestors(match_id) for match_id in matched)

    def evidence_for(skill_id: str) -> str | None:
        node = taxonomy.get_node(skill_id)
        keywords = list(node.keywords) if node is not None else []
        for child in taxonomy.children_of(skill_id):
            child_node = taxonomy.get_node(child)
            if child_node is not None:
                keywords.extend(child_node.keywords)
        for line in lines:
            if any(keyword.lower() in line.lower() for keyword in keywords):
                return line.strip()
        return None

    required = [item for item in requirements if item.get("kind") != "preferred"]
    covered = [item for item in required if is_covered(str(item.get("skillId", "")))]
    gaps = [item for item in required if not is_covered(str(item.get("skillId", "")))]

    def label_of(item: dict[str, object]) -> str:
        return str(item.get("label") or item.get("skillId", ""))

    summary = (
        f"The resume already covers all {len(required)} required skills for {role}."
        if not gaps
        else (
            f"The resume covers {len(covered)} of {len(required)} required skills for "
            f"{role}; {len(gaps)} requirement(s) have no resume evidence — prepare for "
            "them rather than padding the resume."
        )
    )
    alignment = []
    for item in required:
        skill_id = str(item.get("skillId", ""))
        label = label_of(item)
        covered_item = is_covered(skill_id)
        alignment.append(
            {
                "requirement": label,
                "resumeEvidence": evidence_for(skill_id),
                "suggestion": (
                    f'Keep "{label}" prominent — it is a stated requirement.'
                    if covered_item
                    else (
                        "Not in your resume — if you have this experience, add it; "
                        "otherwise see Prepare."
                    )
                ),
            }
        )
    return {
        "summary": summary,
        "emphasize": [label_of(item) for item in covered],
        "deEmphasize": [],
        "alignment": alignment,
        "prepGaps": [label_of(item) for item in gaps],
    }
