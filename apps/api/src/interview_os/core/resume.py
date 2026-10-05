"""Deterministic resume helpers — port of `resume/{ats,bullets,guard}.ts`.

Everything here is pure and runs over untrusted resume text: the ATS check,
weak-bullet selection, and the no-invented-facts guard applied to every AI
suggestion before it is persisted.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from . import taxonomy
from .js_compat import js_round
from .models.resume import (
    AtsCheck,
    AtsCheckStatus,
    AtsKeywordCoverage,
    AtsKeywordMissing,
    AtsKeywordPresent,
    AtsResult,
)
from .models.target import Requirement, RequirementKind

__all__ = [
    "ALLOWLIST",
    "ACTION_VERBS",
    "SECTION_HEADINGS",
    "GuardResult",
    "ats_check",
    "bullet_lines",
    "guard_suggestion",
    "select_weakest_bullets",
]

SECTION_HEADINGS = (
    "experience",
    "work experience",
    "employment",
    "professional experience",
    "education",
    "skills",
    "projects",
    "summary",
    "profile",
    "certifications",
    "publications",
)

ACTION_VERBS = frozenset(
    """
    accelerated achieved analyzed analysed architected automated built coached
    collaborated conceptualized consolidated coordinated created cut debugged
    decreased delivered designed developed directed doubled drove enabled
    engineered established executed expanded founded generated grew headed
    implemented improved increased initiated introduced launched led maintained
    managed mentored migrated modernized modernised negotiated optimized
    optimised orchestrated owned pioneered produced prototyped reduced refactored
    researched resolved scaled shaped shipped simplified spearheaded streamlined
    strengthened transformed tripled wrote
    """.split()
)

# Quantifiers are bounded on purpose: resume text is untrusted, and an
# unbounded ambiguous quantifier is a quadratic ReDoS.
_EMAIL_RE = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}\.[\w.]{1,24}", re.ASCII)
_PHONE_RE = re.compile(r"\+?\d[\d\s().-]{7,20}\d")
_URL_RE = re.compile(r"(https?://|www\.|linkedin\.com|github\.com)", re.IGNORECASE)
_ATS_BULLET_RE = re.compile(r"^\s*(?:[-*•‣◦]|\d+\.)\s*")
_BULLET_RE = re.compile(r"^\s*(?:[-*•‣◦]|\d+\.)\s+")
_ATS_NUMBER_RE = re.compile(
    r"[$€£]?\d[\d,]{0,15}(?:\.\d+)?\s{0,4}(?:%|percent|x|k|m|b)?\b", re.IGNORECASE | re.ASCII
)
_BULLET_NUMBER_RE = re.compile(r"\d")
_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b", re.ASCII)
_MONTH_RE = re.compile(
    r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]{0,9}\.?\s{0,2}['’]?\d{2,4}\b",
    re.IGNORECASE | re.ASCII,
)
_PRESENT_RE = re.compile(r"\b(present|current|ongoing)\b", re.IGNORECASE | re.ASCII)
_FIRST_PERSON_RE = re.compile(r"\b(i|me|my|mine|myself|we|our|us)\b", re.IGNORECASE | re.ASCII)
_LETTER_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
_WORD_LETTER_RE = re.compile(r"[^\W_]", re.UNICODE)
_RE_META_RE = re.compile(r"[.*+?^${}()|\[\]\\]")


def _escape_re(text: str) -> str:
    return _RE_META_RE.sub(lambda match: "\\" + match.group(0), text)


def _count_words(text: str) -> int:
    return sum(1 for word in re.split(r"\s+", text) if _WORD_LETTER_RE.search(word))


def _first_word(line: str) -> str:
    stripped = _ATS_BULLET_RE.sub("", line, count=1).strip()
    match = _LETTER_RE.search(stripped)
    return match.group(0).lower() if match is not None else ""


def _keywords_for(skill_id: str) -> list[str]:
    """All keywords of a skill node plus its descendants (a child counts toward
    its parent)."""

    visited: set[str] = set()
    keywords: set[str] = set()
    stack = [skill_id]
    while stack:
        current = stack.pop()
        if current in visited:
            continue
        visited.add(current)
        node = taxonomy.get_node(current)
        if node is not None:
            keywords.update(node.keywords)
        stack.extend(taxonomy.children_of(current))
    return list(keywords)


def _keyword_in_line(keyword: str, line: str) -> bool:
    pattern = f"(^|[^a-z0-9]){_escape_re(keyword)}([^a-z0-9]|$)"
    return re.search(pattern, line, re.IGNORECASE) is not None


def _worse_of(pass_at: bool, warn_at: bool) -> AtsCheckStatus:
    return (
        AtsCheckStatus.PASS if pass_at else AtsCheckStatus.WARN if warn_at else AtsCheckStatus.FAIL
    )


def ats_check(resume_text: str, requirements: Sequence[Requirement]) -> AtsResult:
    """§9.5 deterministic ATS check. `requirements` are the target role's
    requirements; required ones drive keyword coverage."""

    lines = re.split(r"\r?\n", resume_text)
    words = _count_words(resume_text)
    bullets = bullet_lines(resume_text)
    checks: list[AtsCheck] = []

    contact = {
        "email": _EMAIL_RE.search(resume_text) is not None,
        "phone": _PHONE_RE.search(resume_text) is not None,
        "url": _URL_RE.search(resume_text) is not None,
    }
    contact_found = sum(1 for found in contact.values() if found)
    if contact_found >= 2:
        contact_detail = "Email/phone/link found — recruiters and ATS parsers can reach you."
    elif contact_found == 1:
        found_label = (
            "an email" if contact["email"] else "a phone number" if contact["phone"] else "a link"
        )
        contact_detail = (
            f"Only {found_label} found — add a phone/email and a LinkedIn or portfolio link."
        )
    else:
        contact_detail = "No email, phone number, or link found — ATS systems cannot contact you."
    checks.append(
        AtsCheck(
            id="contact",
            label="Contact information",
            weight=2,
            status=_worse_of(contact_found >= 2, contact_found == 1),
            detail=contact_detail,
        )
    )

    norm = resume_text.lower()
    headings_found = [
        heading
        for heading in SECTION_HEADINGS
        if re.search(rf"(^|\n)\s*#*\s*{_escape_re(heading)}\b", norm, re.IGNORECASE | re.ASCII)
    ]
    if len(headings_found) >= 3:
        headings_detail = (
            f"Found {len(headings_found)} standard sections ({', '.join(headings_found[:4])}…)."
        )
    elif headings_found:
        headings_detail = (
            f'Only "{headings_found[0]}" found — add standard headings like '
            "Experience, Skills, Education."
        )
    else:
        headings_detail = (
            "No standard headings found — ATS parsers look for Experience, Skills, Education."
        )
    checks.append(
        AtsCheck(
            id="headings",
            label="Section headings",
            weight=2,
            status=_worse_of(len(headings_found) >= 3, len(headings_found) >= 1),
            detail=headings_detail,
        )
    )

    checks.append(
        AtsCheck(
            id="length",
            label="Length",
            weight=1,
            status=_worse_of(300 <= words <= 900, (150 <= words < 300) or (900 < words <= 1200)),
            detail=(
                f"{words} words — inside the 300–900 word sweet spot."
                if 300 <= words <= 900
                else f"{words} words — aim for 300–900 words."
            ),
        )
    )

    checks.append(
        AtsCheck(
            id="bullets",
            label="Bullet points",
            weight=1,
            status=_worse_of(len(bullets) >= 6, len(bullets) >= 3),
            detail=(
                f"{len(bullets)} bullets — easy to scan."
                if len(bullets) >= 6
                else (
                    f"{len(bullets)} bullets — aim for at least 6 scannable bullets."
                    if bullets
                    else "No bullet points found — dense paragraphs get skipped."
                )
            ),
        )
    )

    quantified = sum(1 for bullet in bullets if _ATS_NUMBER_RE.search(bullet) is not None)
    ratio = quantified / len(bullets) if bullets else 0
    checks.append(
        AtsCheck(
            id="quantified",
            label="Quantified impact",
            weight=2,
            status=(AtsCheckStatus.FAIL if not bullets else _worse_of(ratio >= 0.3, ratio >= 0.15)),
            detail=(
                "No bullets to quantify — add outcomes with numbers."
                if not bullets
                else f"{quantified} of {len(bullets)} bullets include a number "
                f"({int(js_round(ratio * 100))}%) — aim for ≥30%."
            ),
        )
    )

    verb_starts = sum(1 for bullet in bullets if _first_word(bullet) in ACTION_VERBS)
    verb_ratio = verb_starts / len(bullets) if bullets else 0
    checks.append(
        AtsCheck(
            id="action_verbs",
            label="Action-verb starts",
            weight=1,
            status=(
                AtsCheckStatus.FAIL
                if not bullets
                else _worse_of(verb_ratio >= 0.5, verb_ratio >= 0.3)
            ),
            detail=(
                "No bullets found — start achievements with verbs like Led, Built, Reduced."
                if not bullets
                else f"{verb_starts} of {len(bullets)} bullets start with an action verb "
                f"({int(js_round(verb_ratio * 100))}%) — aim for ≥50%."
            ),
        )
    )

    pronouns = len(_FIRST_PERSON_RE.findall(resume_text))
    checks.append(
        AtsCheck(
            id="first_person",
            label="First-person pronouns",
            weight=1,
            status=_worse_of(pronouns <= 2, pronouns <= 6),
            detail=(
                "No (or almost no) first-person pronouns — correct resume style."
                if pronouns <= 2
                else f"{pronouns} first-person pronouns (I/my/we) — drop them; the implied "
                "subject is you."
            ),
        )
    )

    date_hits = (
        len(_YEAR_RE.findall(resume_text))
        + len(_MONTH_RE.findall(resume_text))
        + (1 if _PRESENT_RE.search(resume_text) is not None else 0)
    )
    checks.append(
        AtsCheck(
            id="dates",
            label="Dates",
            weight=1,
            status=_worse_of(date_hits >= 3, date_hits >= 1),
            detail=(
                "Dates found for your roles/education."
                if date_hits >= 3
                else (
                    "Few dates found — add a date range (e.g. 2021–Present) to every role."
                    if date_hits > 0
                    else "No dates found — every role needs a date range like 2021–Present."
                )
            ),
        )
    )

    required = [req for req in requirements if req.kind == RequirementKind.REQUIRED]
    present: list[AtsKeywordPresent] = []
    missing: list[AtsKeywordMissing] = []
    for req in required:
        keywords = _keywords_for(req.skill_id)
        line = next(
            (line for line in lines if any(_keyword_in_line(k, line) for k in keywords)), None
        )
        label = req.label or taxonomy.label_for(req.skill_id)
        if line is not None:
            present.append(
                AtsKeywordPresent(skill_id=req.skill_id, label=label, snippet=line.strip())
            )
        else:
            missing.append(AtsKeywordMissing(skill_id=req.skill_id, label=label))
    coverage = 1 if not required else len(present) / len(required)
    checks.append(
        AtsCheck(
            id="keywords",
            label="Required-skill keywords",
            weight=3,
            status=(
                AtsCheckStatus.PASS
                if not required or coverage >= 0.7
                else AtsCheckStatus.WARN
                if coverage >= 0.4
                else AtsCheckStatus.FAIL
            ),
            detail=(
                "The target role lists no required skills."
                if not required
                else f"{len(present)} of {len(required)} required skills appear in the resume "
                f"({int(js_round(coverage * 100))}%) — aim for ≥70%."
            ),
        )
    )

    total_weight = sum(check.weight for check in checks)
    score = js_round(
        100
        * sum(
            check.weight
            * (
                1
                if check.status == AtsCheckStatus.PASS
                else 0.5
                if check.status == AtsCheckStatus.WARN
                else 0
            )
            for check in checks
        )
        / total_weight
    )

    return AtsResult(
        score=int(score),
        checks=checks,
        keyword_coverage=AtsKeywordCoverage(present=present, missing=missing),
    )


def bullet_lines(resume_text: str) -> list[str]:
    """Resume bullet lines, trimmed of their bullet marker."""

    return [line.strip() for line in re.split(r"\r?\n", resume_text) if _BULLET_RE.match(line)]


# Bounded quantifiers throughout: the lazy group may end at any space, so every
# `\s` run must be bounded to keep each backtracking step O(1).
_HEADING_RE = re.compile(
    r"^\s{0,4}#{1,6}\s{0,4}(\S.{0,120}?)\s{0,4}$|^\s{0,4}([A-Z][A-Za-z &/]{2,40})\s{0,4}:?\s{0,4}$"
)
_EXPERIENCE_SECTION_RE = re.compile(
    r"experience|work|employment|professional|career|projects?|history", re.IGNORECASE
)
_NON_EXPERIENCE_SECTION_RE = re.compile(
    r"education|academics?|skills|technologies|contact|summary|objective|profile|references"
    r"|languages|awards|certifications|interests|publications|links",
    re.IGNORECASE,
)
_BULLET_ACTION_VERB_RE = re.compile(
    r"^\s*(?:[-*•‣◦]|\d+\.)\s*(accelerated|achieved|analy[sz]ed|architected|automated|built"
    r"|coached|collaborated|consolidated|coordinated|created|cut|debugged|decreased|delivered"
    r"|designed|developed|directed|doubled|drove|enabled|engineered|established|executed"
    r"|expanded|founded|generated|grew|headed|implemented|improved|increased|initiated"
    r"|introduced|launched|led|maintained|managed|mentored|migrated|modernized|modernised"
    r"|negotiated|optimi[sz]ed|orchestrated|owned|pioneered|produced|prototyped|reduced"
    r"|refactored|researched|resolved|scaled|shaped|shipped|simplified|spearheaded"
    r"|streamlined|strengthened|transformed|tripled|wrote)\b",
    re.IGNORECASE | re.ASCII,
)


def select_weakest_bullets(resume_text: str, max: int = 8) -> list[str]:
    """§9.5: deterministically pick up to `max` weakest bullets for coaching —
    only bullets inside experience/projects sections (never education, skills,
    contact, summary). Weak = lacks a number and/or an action-verb start; ties
    keep resume order."""

    section: str | None = None
    candidates: list[tuple[str, int]] = []
    for index, line in enumerate(re.split(r"\r?\n", resume_text)):
        heading = _HEADING_RE.match(line)
        if heading is not None:
            section = heading.group(1) if heading.group(1) is not None else heading.group(2)
            continue
        if _BULLET_RE.match(line) is None:
            continue
        if section is None:
            # before any heading — e.g. a free-form top block; only take it if we
            # haven't seen a restricted section name anywhere yet
            candidates.append((line.strip(), index))
            continue
        if _EXPERIENCE_SECTION_RE.search(section) is not None:
            candidates.append((line.strip(), index))
        elif _NON_EXPERIENCE_SECTION_RE.search(section) is None:
            candidates.append((line.strip(), index))

    scored = [
        (
            text,
            index,
            (0 if _BULLET_NUMBER_RE.search(text) is not None else 1)
            + (0 if _BULLET_ACTION_VERB_RE.search(text) is not None else 1),
        )
        for text, index in candidates
    ]
    scored.sort(key=lambda item: (-item[2], item[1]))
    return [text for text, _, _ in scored[:max]]


@dataclass(frozen=True, slots=True)
class GuardResult:
    """§9.5 guard verdict for one suggestion."""

    #: false when the suggestion was dropped entirely.
    ok: bool
    #: improved text after `[add metric]` substitutions (dropped or not).
    improved: str
    #: why the suggestion was dropped.
    dropped: str | None
    #: numeric claims replaced with `[add metric]`.
    substitutions: list[str]


# All quantifiers over untrusted resume/suggestion text are bounded.
# "40%", "$120k", "€1.5M", "10x", "3M", "10,000" — not "IPv4"/"O(n4)".
_NUMBER_TOKEN_RE = re.compile(
    r"(?<![\w$€£])(?:[$€£]\s{0,2})?\d[\d,]{0,19}(?:\.\d{1,6})?\s{0,2}(?:%|percent\b|[xkmb]\b)"
    r"|(?<![\w$€£])[$€£]\s{0,2}\d[\d,]{0,19}(?:\.\d{1,6})?"
    r"|(?<![\w$€£.])\d[\d,]{0,19}(?:\.\d{1,6})?\b",
    re.IGNORECASE | re.ASCII,
)

# Capitalised multi-letter tokens: PostgreSQL, AWS, Node.js, C#, C++.
_ENTITY_RE = re.compile(
    r"(?<![\w.])[A-Z][A-Za-z0-9]{0,30}(?:(?:[.+#][A-Za-z0-9]{1,8})|[+#]{1,4}){0,6}", re.ASCII
)

_PLACEHOLDER_RE = re.compile(r"\[[^\]]{0,64}\]")

# Sentence-initial/common English words that are fine capitalised — modest on
# purpose. Technology names (API, REST, SQL, AWS…) are deliberately NOT here:
# they must appear in the resume or the suggestion is dropped.
ALLOWLIST = frozenset(
    """
    the a an in on at for to with by from as and or but not no nor so yet we our
    this that these those when while after before during across over under within
    into per via it its he she they their his her
    accelerated achieved analyzed analysed architected automated built builds
    coached collaborated consolidated coordinated created cut debugged decreased
    delivered delivers designed developed directed doubled drove enabled engineered
    established executed expanded founded generated grew headed implemented
    improved increased initiated introduced launched led leads maintained managed
    mentored migrated modernized modernised negotiated optimized optimised
    orchestrated owned owns pioneered produced prototyped reduced reduces
    refactored researched resolved scaled shaped shipped simplified spearheaded
    streamlined strengthened transformed tripled wrote drives guides guide grew
    growing saved saves earned secured raised boosted achieving ensuring using
    jan january feb february mar march apr april may jun june jul july aug august
    sep sept september oct october nov november dec december mon monday tue tues
    tuesday wed wednesday thu thur thurs thursday fri friday sat saturday sun
    sunday q1 q2 q3 q4
    ok etc present current
    """.split()
)


def _normalize(text: str) -> str:
    """Normalise for presence checks: lowercase, strip thousands separators."""

    return re.sub(r"\s+", " ", re.sub(r"(\d),(\d{3})", r"\1\2", text.lower()))


def _mask_placeholders(text: str) -> list[bool]:
    mask = [False] * len(text)
    for match in _PLACEHOLDER_RE.finditer(text):
        for index in range(match.start(), match.end()):
            mask[index] = True
    return mask


def _numeric_core(token: str) -> str:
    """Numeric core of a token ("$1.5M" → "1.5", "40%" → "40", "10,000" → "10000")."""

    match = re.search(r"\d+(?:\.\d+)?", token.replace(",", ""))
    return match.group(0) if match is not None else ""


def _contains_number(haystack_norm: str, core: str) -> bool:
    if not core:
        return False
    return re.search(rf"(?<![\d.]){re.escape(core)}(?![\d])", haystack_norm) is not None


def _contains_entity(haystack_norm: str, token: str) -> bool:
    return (
        re.search(rf"(^|[^\w]){re.escape(token.lower())}([^\w]|$)", haystack_norm, re.ASCII)
        is not None
    )


def guard_suggestion(original: str, improved: str, resume_text: str) -> GuardResult:
    """§9.5 no-invented-facts guard, applied to every AI resume suggestion before
    persisting: numeric claims not present in the resume (or the original bullet)
    become `[add metric]`; capitalised entities absent from the resume and outside
    a small common-word allowlist get the suggestion dropped."""

    resume_norm = _normalize(resume_text)
    original_norm = _normalize(original)
    mask = _mask_placeholders(improved)
    substitutions: list[str] = []

    out = ""
    last = 0
    for match in _NUMBER_TOKEN_RE.finditer(improved):
        start = match.start()
        end = match.end()
        if mask[start]:
            continue
        token = match.group(0).strip()
        core = _numeric_core(token)
        if _contains_number(resume_norm, core) or _contains_number(original_norm, core):
            continue
        out += improved[last:start] + "[add metric]"
        last = end
        substitutions.append(token)
    out += improved[last:]
    guarded = out
    guarded_mask = _mask_placeholders(guarded)

    offenders: list[str] = []
    for match in _ENTITY_RE.finditer(guarded):
        token = match.group(0)
        if guarded_mask[match.start()]:
            continue
        if len("".join(char for char in token if char.isalpha())) < 2:
            continue
        if token.lower() in ALLOWLIST:
            continue
        if token in offenders:
            continue
        if _contains_entity(resume_norm, token) or _contains_entity(original_norm, token):
            continue
        offenders.append(token)

    if offenders:
        return GuardResult(
            ok=False,
            improved=guarded,
            dropped=(
                f"invented {'name' if len(offenders) == 1 else 'names'} not in the resume: "
                f"{', '.join(offenders)}"
            ),
            substitutions=substitutions,
        )
    return GuardResult(ok=True, improved=guarded, dropped=None, substitutions=substitutions)
