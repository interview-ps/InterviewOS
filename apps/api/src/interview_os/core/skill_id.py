"""Skill ids: a dotted lowercase path (`sql.indexing`), ported from `skill-id.ts`.

This is a branded string type in TypeScript, so it stays an `Annotated[str]`
alias here — never a wrapper class — plus the same helpers.
"""

from __future__ import annotations

import re
from typing import Annotated

from pydantic import StringConstraints

__all__ = [
    "SKILL_ID_REGEX",
    "SkillId",
    "humanize_skill_segment",
    "is_skill_id",
    "parent_skill_id",
]

SKILL_ID_REGEX = r"^[a-z0-9-]+(\.[a-z0-9-]+)*$"

SkillId = Annotated[str, StringConstraints(pattern=SKILL_ID_REGEX)]

_SKILL_ID_RE = re.compile(SKILL_ID_REGEX)


def is_skill_id(value: str) -> bool:
    return _SKILL_ID_RE.fullmatch(value) is not None


def parent_skill_id(skill_id: str) -> SkillId | None:
    index = skill_id.rfind(".")
    return None if index == -1 else skill_id[:index]


def humanize_skill_segment(segment: str) -> str:
    return " ".join(part[:1].upper() + part[1:] for part in segment.split("-") if part)
