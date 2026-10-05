"""Core resume helpers used by `ResumeService` — parity with the TS originals.

The expectations below were captured from the TypeScript implementation
(`packages/core/src/resume/*`) through a throwaway `tsx` harness and matched
the Python port byte-for-byte before being committed here.
"""

from __future__ import annotations

from pathlib import Path

from interview_os.core.models import Requirement, RequirementKind
from interview_os.core.resume import (
    ats_check,
    bullet_lines,
    guard_suggestion,
    select_weakest_bullets,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
RESUME = (REPO_ROOT / "examples" / "backend-engineer" / "resume.md").read_text(encoding="utf-8")

REQUIREMENTS = [
    Requirement(
        skill_id="sql", label="SQL", importance=0.9, kind=RequirementKind.REQUIRED, evidence="sql"
    ),
    Requirement(
        skill_id="distributed-systems",
        label="",
        importance=0.8,
        kind=RequirementKind.REQUIRED,
        evidence="x",
    ),
    Requirement(
        skill_id="apis", label="APIs", importance=0.6, kind=RequirementKind.PREFERRED, evidence="y"
    ),
]

SYNTHETIC_RESUME = """Jane Doe — jane@example.com — +1 (555) 123-4567 — https://github.com/jane

Experience
- Built the payments API in Go
- responsible for the billing migration
- Led the team that cut latency by 30% (2021-2024)
Education
- BSc Computer Science
Skills
- Go, PostgreSQL, Kafka

Summary
- Owned the platform roadmap

Projects
- Designed a caching layer
- wrote a CLI in Rust"""


def test_ats_check_matches_the_ts_result() -> None:
    result = ats_check(RESUME, REQUIREMENTS)
    assert result.score == 39
    assert [(check.id, check.status.value) for check in result.checks] == [
        ("contact", "fail"),
        ("headings", "pass"),
        ("length", "fail"),
        ("bullets", "pass"),
        ("quantified", "fail"),
        ("action_verbs", "fail"),
        ("first_person", "pass"),
        ("dates", "fail"),
        ("keywords", "warn"),
    ]
    assert [item.skill_id for item in result.keyword_coverage.present] == ["sql"]
    assert [item.skill_id for item in result.keyword_coverage.missing] == ["distributed-systems"]
    assert "SQL datastore" in result.keyword_coverage.present[0].snippet


def test_ats_check_on_an_empty_resume() -> None:
    result = ats_check("", [])
    assert result.score == 29
    assert result.checks[0].detail == (
        "No email, phone number, or link found — ATS systems cannot contact you."
    )
    assert result.checks[8].detail == "The target role lists no required skills."


def test_bullet_lines_and_weakest_selection() -> None:
    assert bullet_lines(SYNTHETIC_RESUME) == [
        "- Built the payments API in Go",
        "- responsible for the billing migration",
        "- Led the team that cut latency by 30% (2021-2024)",
        "- BSc Computer Science",
        "- Go, PostgreSQL, Kafka",
        "- Owned the platform roadmap",
        "- Designed a caching layer",
        "- wrote a CLI in Rust",
    ]
    # education/skills/summary bullets are never coached; ties keep resume order
    assert select_weakest_bullets(SYNTHETIC_RESUME) == [
        "- responsible for the billing migration",
        "- Built the payments API in Go",
        "- Designed a caching layer",
        "- wrote a CLI in Rust",
        "- Led the team that cut latency by 30% (2021-2024)",
    ]
    assert select_weakest_bullets(SYNTHETIC_RESUME, 2) == [
        "- responsible for the billing migration",
        "- Built the payments API in Go",
    ]
    assert select_weakest_bullets("") == []


def test_guard_substitutes_numbers_and_drops_invented_names() -> None:
    dropped = guard_suggestion(
        "Worked on the API",
        "Built the API, reducing latency by 40% and serving 10,000 users on AWS",
        RESUME,
    )
    assert dropped.ok is False
    assert dropped.improved == (
        "Built the API, reducing latency by [add metric] and serving [add metric] users on AWS"
    )
    assert dropped.dropped == "invented name not in the resume: AWS"
    assert dropped.substitutions == ["40%", "10,000"]

    kept = guard_suggestion("Worked on the API", "Built the API reducing latency by 40%", RESUME)
    assert kept.ok is True
    assert kept.improved == "Built the API reducing latency by [add metric]"
    assert kept.dropped is None
    assert kept.substitutions == ["40%"]

    invented = guard_suggestion("Worked on the API", "Built Kafka pipelines with Snowflake", RESUME)
    assert invented.ok is False
    assert invented.dropped == "invented names not in the resume: Kafka, Snowflake"
    assert invented.substitutions == []


def test_guard_keeps_placeholders_and_present_numbers() -> None:
    placeholder = guard_suggestion("Worked on the API", "Reduced latency by [add metric]", RESUME)
    assert placeholder.ok is True
    assert placeholder.improved == "Reduced latency by [add metric]"
    assert placeholder.substitutions == []

    currency = guard_suggestion("Worked on the API", "Cut costs by $1.5M and 3x throughput", RESUME)
    assert currency.ok is True
    assert currency.improved == "Cut costs by [add metric] and [add metric] throughput"
    assert currency.substitutions == ["$1.5M", "3x"]

    present = guard_suggestion("x", "Saved 15% of costs", "saved 15% of costs")
    assert present.ok is True
    assert present.improved == "Saved 15% of costs"
    assert present.substitutions == []

    thousands = guard_suggestion("x", "Cut €1,5 M costs", "€1,5 M budget")
    assert thousands.ok is True
    assert thousands.improved == "Cut [add metric] costs"

    not_a_metric = guard_suggestion(
        "x", "Improved throughput by [add metric] and cut O(n4) work", "O(n4)"
    )
    assert not_a_metric.ok is True
    assert not_a_metric.improved == "Improved throughput by [add metric] and cut O(n4) work"
