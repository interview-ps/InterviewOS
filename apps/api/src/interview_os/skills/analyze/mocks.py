"""Analyze-skill mock handlers — ports of `skills/analyze/*/mock.ts`."""

from __future__ import annotations

import re

from ...core import taxonomy
from ...core.skill_id import SkillId
from ..mock.text import MarkdownSection, bullets_of, first_matching_line, split_sections, strip_md

__all__ = ["company_profiler_mock", "jd_analyzer_mock", "resume_analyzer_mock"]

_EXPERIENCE_HEADING = re.compile(r"experience|employment|work history")
_EDUCATION_HEADING = re.compile(r"education")
_PROJECT_HEADING = re.compile(r"project")
_ACHIEVEMENT_HEADING = re.compile(r"achievement|accomplishment|award")
_PREFERRED_HEADING = re.compile(r"prefer|nice to have|bonus|plus\b", re.I)
_VALUE_LINE = re.compile(r"value|principle|believe|we care|we look for|we hire|mindset", re.I)
_INTERVIEW_LINE = re.compile(r"interview|loop|onsite|process", re.I)

_THEME_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("ownership", re.compile(r"ownership|own it|accountab|end-to-end", re.I)),
    ("customer focus", re.compile(r"customer|user[- ]first|obsession", re.I)),
    ("bias for action", re.compile(r"bias for action|move fast|ship|velocity|urgency", re.I)),
    ("collaboration", re.compile(r"collaborat|together|cross-functional|team first", re.I)),
    ("reliability", re.compile(r"reliab|resilien|uptime|correctness", re.I)),
    ("learning", re.compile(r"learn|grow|curious|growth mindset", re.I)),
)


def _level_for(mentions: int) -> float:
    return min(0.9, 0.45 + 0.15 * mentions)


def _bullets_of_section(sections: list[MarkdownSection], pattern: re.Pattern[str]) -> list[str]:
    return [
        strip_md(line)
        for section in sections
        if pattern.search(section.heading)
        for line in bullets_of(section.lines)
    ]


def resume_analyzer_mock(input: object) -> object:
    data = input if isinstance(input, dict) else {}
    resume_text = str(data.get("resumeText", ""))
    sections = split_sections(resume_text)

    skills = [
        {
            "skillId": match.skill_id,
            "level": _level_for(match.mentions),
            "source": "resume",
            "evidence": first_matching_line(resume_text, match.skill_id),
        }
        for match in taxonomy.match_skills(resume_text)
    ]

    experience = []
    for line in _bullets_of_section(sections, _EXPERIENCE_HEADING):
        parts = re.split(r"\s+[—–-]\s+|\s+@\s+", line)
        title = parts[0] if parts else line
        company = parts[1] if len(parts) > 1 else ""
        rest = parts[2:]
        experience.append(
            {"title": title, "company": company, "highlights": [" — ".join(rest)] if rest else []}
        )

    education = []
    for line in _bullets_of_section(sections, _EDUCATION_HEADING):
        parts = re.split(r"\s+[—–,]\s+", line)
        degree = parts[0] if parts else line
        institution = parts[1] if len(parts) > 1 else ""
        education.append({"institution": institution, "degree": degree})

    projects: list[dict[str, object]] = []
    for line in _bullets_of_section(sections, _PROJECT_HEADING):
        parts = re.split(r"[—–:]\s+", line)
        name = parts[0] if parts else line
        rest = parts[1:]
        projects.append({"name": name, "description": ": ".join(rest) or line, "technologies": []})

    achievements = _bullets_of_section(sections, _ACHIEVEMENT_HEADING)

    lines = [line.strip() for line in resume_text.split("\n")]
    h1 = next((line for line in lines if re.match(r"^#\s+", line)), None)
    heading_line = next((line for line in lines if line and not line.startswith("#")), None)

    return {
        "name": re.sub(r"^#+\s*", "", h1).strip() if h1 else heading_line,
        "headline": None,
        "experience": experience,
        "skills": skills,
        "projects": projects,
        "achievements": achievements,
        "education": education,
        "starStories": [],
    }


def jd_analyzer_mock(input: object) -> object:
    data = input if isinstance(input, dict) else {}
    job_description = str(data.get("jobDescription", ""))
    lines = job_description.split("\n")
    split_idx = next(
        (index for index, line in enumerate(lines) if _PREFERRED_HEADING.search(line)), -1
    )
    required_text = job_description if split_idx == -1 else "\n".join(lines[:split_idx])
    preferred_text = "" if split_idx == -1 else "\n".join(lines[split_idx:])

    required_matches = taxonomy.match_skills(required_text)
    preferred_matches = taxonomy.match_skills(preferred_text)
    required_ids = {match.skill_id for match in required_matches}

    requirements = [
        {
            "skillId": match.skill_id,
            "label": taxonomy.label_for(match.skill_id),
            "importance": min(0.95, 0.75 + 0.05 * (match.mentions - 1)),
            "kind": "required",
            "evidence": first_matching_line(required_text, match.skill_id),
        }
        for match in required_matches
    ]
    preferred_skills = [
        {
            "skillId": match.skill_id,
            "label": taxonomy.label_for(match.skill_id),
            "importance": 0.5,
            "kind": "preferred",
            "evidence": first_matching_line(preferred_text, match.skill_id),
        }
        for match in preferred_matches
        if match.skill_id not in required_ids
    ]
    return {"requirements": requirements, "preferredSkills": preferred_skills}


def company_profiler_mock(input: object) -> object:
    data = input if isinstance(input, dict) else {}
    company_notes = str(data.get("companyNotes", ""))
    lines = [strip_md(line) for line in bullets_of(company_notes.split("\n"))]
    lines = [line for line in lines if line]

    values: list[str] = []
    for line in lines:
        if _VALUE_LINE.search(line):
            trimmed = line[:120]
            if trimmed not in values:
                values.append(trimmed)
    values = values[:6]

    focus_skill_ids: list[SkillId] = [
        match.skill_id for match in taxonomy.match_skills(company_notes)[:8]
    ]
    behavioral_themes = [
        theme for theme, pattern in _THEME_PATTERNS if pattern.search(company_notes)
    ]
    interview_line = next((line for line in lines if _INTERVIEW_LINE.search(line)), "")
    interview_style = interview_line[:160] if _INTERVIEW_LINE.search(company_notes) else ""

    return {
        "values": values,
        "interviewStyle": interview_style,
        "focusSkillIds": focus_skill_ids,
        "behavioralThemes": behavioral_themes,
    }
