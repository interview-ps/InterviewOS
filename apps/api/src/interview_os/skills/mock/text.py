"""Mock text helpers — port of `apps/server/src/skills/mock/text.ts`."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ...core import taxonomy
from ...core.skill_id import SkillId

__all__ = ["MarkdownSection", "bullets_of", "first_matching_line", "split_sections", "strip_md"]

_HEADING_RE = re.compile(r"^#{1,3}\s{1,4}(\S.{0,120})$")
_BULLET_RE = re.compile(r"^\s*[-*•]\s+")


def first_matching_line(text: str, skill_id: SkillId) -> str:
    node = taxonomy.get_node(skill_id)
    keywords = node.keywords if node is not None else []
    for line in text.split("\n"):
        lower = line.lower()
        if any(keyword.lower() in lower for keyword in keywords):
            return line.strip()[:160]
    tail = skill_id.split(".")[-1]
    for line in text.split("\n"):
        if tail in line.strip().lower():
            return line.strip()[:160]
    for line in text.split("\n"):
        if line.strip():
            return line.strip()[:160]
    return ""


@dataclass(slots=True)
class MarkdownSection:
    heading: str = ""
    lines: list[str] = field(default_factory=list)


def split_sections(text: str) -> list[MarkdownSection]:
    sections: list[MarkdownSection] = [MarkdownSection()]
    for raw_line in text.split("\n"):
        line = raw_line.removesuffix("\r")
        match = _HEADING_RE.match(line)
        if match:
            sections.append(MarkdownSection(heading=match.group(1).strip().lower()))
        else:
            sections[-1].lines.append(line)
    return sections


def bullets_of(lines: list[str]) -> list[str]:
    return [cleaned for line in lines if (cleaned := _BULLET_RE.sub("", line).strip())]


def strip_md(text: str) -> str:
    return text.replace("**", "").replace("`", "").strip()
