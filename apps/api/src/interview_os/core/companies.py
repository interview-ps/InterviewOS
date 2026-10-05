"""Built-in company profiles and pack compilation — port of `companies/` + the
`compileCompanyPack` half of `packs/index.ts`.

Originally-written public interview patterns; `match_profile_in` matches a
free-text company name by name/alias and falls back to `generic`.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from .models.companies import (
    COMPANY_DISCLAIMER,
    CompanyBehavioralFramework,
    CompanyEmphasis,
    CompanyPackInfo,
    CompanyProfile,
    CompanyTypicalLoopStage,
)
from .models.packs import (
    CompanyPackStage,
    CompanyPackWithOverlays,
    PackItem,
    PackQuestion,
    Provenance,
)

__all__ = [
    "COMPANY_PROFILES",
    "amazon_profile",
    "compile_company_pack",
    "generic_profile",
    "get_company_profile",
    "google_profile",
    "match_company_profile",
    "match_profile_in",
    "meta_profile",
    "microsoft_profile",
]

generic_profile = CompanyProfile(
    id="generic",
    name="Generic",
    aliases=[],
    disclaimer=COMPANY_DISCLAIMER,
    typical_loop=[
        CompanyTypicalLoopStage(mode="technical", label="Technical screen", planned_questions=4),
        CompanyTypicalLoopStage(mode="coding", label="Coding round", planned_questions=2),
        CompanyTypicalLoopStage(mode="system_design", label="System design", planned_questions=4),
        CompanyTypicalLoopStage(mode="behavioral", label="Behavioral", planned_questions=4),
        CompanyTypicalLoopStage(mode="hr", label="HR / culture", planned_questions=3),
    ],
    emphasis=[],
    behavioral_framework=CompanyBehavioralFramework(
        name="STAR",
        themes=["ownership", "collaboration", "conflict resolution", "learning from failure"],
        guidance=(
            "Probe for a specific past situation; expect Situation → Task → Action → Result "
            "with at least one concrete outcome."
        ),
    ),
    follow_up_depth=1,
    rubric_emphasis={},
    role_expectations={
        "junior": ["solid fundamentals", "learns quickly", "asks good clarifying questions"],
        "mid": ["delivers independently", "owns medium-sized features end to end"],
        "senior": ["drives projects across teams", "mentors others", "makes sound trade-offs"],
        "staff": [
            "sets technical direction",
            "influences beyond own team",
            "unblocks ambiguous programs",
        ],
    },
)

google_profile = CompanyProfile(
    id="google",
    name="Google",
    aliases=["google", "alphabet"],
    disclaimer=COMPANY_DISCLAIMER,
    typical_loop=[
        CompanyTypicalLoopStage(mode="coding", label="Coding I", planned_questions=2),
        CompanyTypicalLoopStage(mode="coding", label="Coding II", planned_questions=2),
        CompanyTypicalLoopStage(mode="system_design", label="System design", planned_questions=4),
        CompanyTypicalLoopStage(
            mode="behavioral", label="Behavioral (Googleyness)", planned_questions=4
        ),
    ],
    emphasis=[
        CompanyEmphasis(skill_id="coding", weight=0.08),
        CompanyEmphasis(skill_id="coding.complexity", weight=0.06),
        CompanyEmphasis(skill_id="system-design", weight=0.05),
    ],
    behavioral_framework=CompanyBehavioralFramework(
        name="Googleyness",
        themes=[
            "comfort with ambiguity",
            "collaboration across teams",
            "humility and learning",
            "doing the right thing for users",
        ],
        guidance=(
            "Favor stories about navigating ambiguity, helping others succeed, and pushing back "
            "respectfully with data."
        ),
    ),
    follow_up_depth=2,
    rubric_emphasis={"complexity": 1.2, "problemUnderstanding": 1.1},
    role_expectations={
        "junior": ["strong CS fundamentals", "clean coding under guidance"],
        "mid": ["solves novel coding problems independently", "clear complexity reasoning"],
        "senior": ["designs systems at scale", "handles ambiguous requirements"],
        "staff": ["industry-level design depth", "leads technical strategy discussions"],
    },
)

meta_profile = CompanyProfile(
    id="meta",
    name="Meta",
    aliases=["meta", "facebook"],
    disclaimer=COMPANY_DISCLAIMER,
    typical_loop=[
        CompanyTypicalLoopStage(mode="coding", label="Coding I", planned_questions=2),
        CompanyTypicalLoopStage(mode="coding", label="Coding II", planned_questions=2),
        CompanyTypicalLoopStage(
            mode="system_design", label="Product/system design", planned_questions=4
        ),
        CompanyTypicalLoopStage(mode="behavioral", label="Behavioral", planned_questions=4),
        CompanyTypicalLoopStage(mode="hiring_manager", label="Hiring manager", planned_questions=3),
    ],
    emphasis=[
        CompanyEmphasis(skill_id="coding", weight=0.08),
        CompanyEmphasis(skill_id="coding.data-structures", weight=0.05),
        CompanyEmphasis(skill_id="system-design", weight=0.05),
    ],
    behavioral_framework=CompanyBehavioralFramework(
        name="Meta values",
        themes=["move fast", "focus on impact", "be bold", "build social value"],
        guidance=(
            "Favor stories about shipping quickly under uncertainty, choosing impact over "
            "polish, and resolving disagreement directly."
        ),
    ),
    follow_up_depth=1,
    rubric_emphasis={"approach": 1.1, "impact": 1.1},
    role_expectations={
        "junior": ["productive coder", "ramp quickly with support"],
        "mid": ["ships end-to-end", "strong debugging instincts"],
        "senior": ["drives ambiguous projects", "cross-functional influence"],
        "staff": ["org-level technical leadership", "multiplies team output"],
    },
)

amazon_profile = CompanyProfile(
    id="amazon",
    name="Amazon",
    aliases=["amazon", "aws", "amazon web services"],
    disclaimer=COMPANY_DISCLAIMER,
    typical_loop=[
        CompanyTypicalLoopStage(mode="coding", label="Coding", planned_questions=2),
        CompanyTypicalLoopStage(
            mode="behavioral", label="Leadership Principles I", planned_questions=4
        ),
        CompanyTypicalLoopStage(
            mode="behavioral", label="Leadership Principles II", planned_questions=4
        ),
        CompanyTypicalLoopStage(mode="system_design", label="System design", planned_questions=4),
        CompanyTypicalLoopStage(mode="hiring_manager", label="Hiring manager", planned_questions=3),
    ],
    emphasis=[
        CompanyEmphasis(skill_id="behavioral", weight=0.08),
        CompanyEmphasis(skill_id="behavioral.ownership", weight=0.06),
        CompanyEmphasis(skill_id="coding", weight=0.04),
    ],
    behavioral_framework=CompanyBehavioralFramework(
        name="Leadership Principles",
        themes=[
            "customer obsession",
            "ownership",
            "bias for action",
            "dive deep",
            "deliver results",
            "earn trust",
            "have backbone; disagree and commit",
            "learn and be curious",
        ],
        guidance=(
            "Each behavioral answer should map to a Leadership Principle; probe two levels deep "
            "on the candidate's personal contribution and the measurable result."
        ),
    ),
    follow_up_depth=2,
    rubric_emphasis={"ownership": 1.2, "results": 1.2, "decisionMaking": 1.1},
    role_expectations={
        "junior": ["delivers with guidance", "learns quickly", "bias for action"],
        "mid": ["owns features end to end", "dives deep into data"],
        "senior": ["owns services/systems", "influences without authority", "develops others"],
        "staff": ["org-wide ownership", "long-term technical vision"],
    },
)

microsoft_profile = CompanyProfile(
    id="microsoft",
    name="Microsoft",
    aliases=["microsoft", "msft"],
    disclaimer=COMPANY_DISCLAIMER,
    typical_loop=[
        CompanyTypicalLoopStage(mode="coding", label="Coding", planned_questions=2),
        CompanyTypicalLoopStage(mode="technical", label="Technical deep dive", planned_questions=4),
        CompanyTypicalLoopStage(mode="system_design", label="Design", planned_questions=4),
        CompanyTypicalLoopStage(mode="behavioral", label="Behavioral", planned_questions=4),
        CompanyTypicalLoopStage(
            mode="hiring_manager", label="As-appropriate (hiring manager)", planned_questions=3
        ),
    ],
    emphasis=[
        CompanyEmphasis(skill_id="coding", weight=0.06),
        CompanyEmphasis(skill_id="system-design", weight=0.05),
        CompanyEmphasis(skill_id="hiring-manager", weight=0.04),
    ],
    behavioral_framework=CompanyBehavioralFramework(
        name="Growth mindset",
        themes=[
            "growth mindset",
            "customer obsession",
            "diverse and inclusive collaboration",
            "making others around you better",
        ],
        guidance=(
            "Favor stories about learning from feedback, inclusive collaboration across teams, "
            "and putting customer outcomes first."
        ),
    ),
    follow_up_depth=1,
    rubric_emphasis={"leadership": 1.1, "collaboration": 1.1},
    role_expectations={
        "junior": ["solid fundamentals", "openness to feedback"],
        "mid": ["independent delivery", "good collaboration hygiene"],
        "senior": ["drives multi-team work", "mentors", "customer-focused design"],
        "staff": ["division-level influence", "technical strategy"],
    },
)

COMPANY_PROFILES: list[CompanyProfile] = [
    generic_profile,
    google_profile,
    meta_profile,
    amazon_profile,
    microsoft_profile,
]

_WORD_SPLIT = re.compile(r"[^a-z0-9]+")


def get_company_profile(profile_id: str) -> CompanyProfile:
    for profile in COMPANY_PROFILES:
        if profile.id == profile_id:
            return profile
    return generic_profile


def match_company_profile(company_name: str) -> CompanyProfile:
    return match_profile_in(COMPANY_PROFILES, company_name)


def match_profile_in(profiles: Sequence[CompanyProfile], company_name: str) -> CompanyProfile:
    """Match a free-text company name by name/alias, case-insensitive and on word
    boundaries; falls back to `generic`."""

    name = company_name.lower().strip()
    if not name:
        return generic_profile
    words = {word for word in _WORD_SPLIT.split(name) if word}
    for profile in profiles:
        if profile.id == "generic":
            continue
        if profile.name.lower().strip() == name:
            return profile
        for alias in profile.aliases:
            normalized = alias.lower().strip()
            if normalized == name:
                return profile
            # multi-word aliases ("amazon web services") match as phrases;
            # single-word aliases match on a word boundary
            if normalized in name if " " in normalized else normalized in words:
                return profile
    return generic_profile


def compile_company_pack(pack: CompanyPackWithOverlays) -> CompanyProfile:
    """Compile a company pack into a `CompanyProfile` the rest of the app consumes."""

    sourced_count = 0
    community_count = 0

    def count(items: Sequence[PackItem | PackQuestion | CompanyPackStage]) -> None:
        nonlocal sourced_count, community_count
        for item in items:
            if item.provenance == Provenance.SOURCED:
                sourced_count += 1
            else:
                community_count += 1

    count(pack.stages)
    count(pack.competencies)
    count(pack.question_style)
    count(pack.evaluation_guidance)
    count(pack.questions)
    for overlay in pack.overlays:
        count(overlay.competencies)
        count(overlay.question_style)
        count(overlay.evaluation_guidance)
        count(overlay.stages or [])
        count(overlay.questions)

    return CompanyProfile(
        id=pack.id,
        name=pack.name,
        aliases=pack.aliases,
        disclaimer=(
            COMPANY_DISCLAIMER
            + " Community pack — items marked community are unverified observations."
        ),
        typical_loop=[
            CompanyTypicalLoopStage(
                mode=stage.mode, label=stage.label, planned_questions=stage.planned_questions
            )
            for stage in pack.stages
        ],
        emphasis=pack.emphasis,
        behavioral_framework=CompanyBehavioralFramework(
            name=pack.behavioral_framework.name,
            themes=pack.behavioral_framework.themes,
            guidance=pack.behavioral_framework.guidance,
        ),
        follow_up_depth=pack.follow_up_depth,
        rubric_emphasis={},
        role_expectations=pack.role_expectations,
        pack=CompanyPackInfo(
            version=pack.version,
            kind="company",
            sourced_count=sourced_count,
            community_count=community_count,
        ),
    )
