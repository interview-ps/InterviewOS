"""Parity oracle: every `tests/golden/*.json` case must reproduce exactly.

The fixtures are language-neutral captures of the TypeScript core's pure logic
(`tests/golden/README.md`). This module dispatches each case's `fn` to the
Python port, converts JSON inputs to core types, and compares outputs with the
documented rules: strings/ints/bools/null/structure exactly, floats with
`math.isclose(rel_tol=1e-12, abs_tol=1e-12)`, key order irrelevant, array
order significant. Error cases compare `error.name` + `error.message` exactly,
except `ZodError` — a Pydantic `ValidationError` must fail on the same field
paths with the same constraint kinds.

Taxonomy cases run in file order because `getNode` mutates the module registry
for valid-but-unknown ids (README "Gotchas the fixtures encode").
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from interview_os.core import taxonomy
from interview_os.core.gaps import calculate_gaps
from interview_os.core.js_compat import parse_iso_datetime
from interview_os.core.models.interview import (
    InterviewEvent,
    InterviewStatus,
)
from interview_os.core.models.preparation import PrepResource
from interview_os.core.models.readiness import Evidence, SkillReadiness
from interview_os.core.models.target import Level, Requirement
from interview_os.core.prioritize import (
    SelectNextSkillInput,
    difficulty_for,
    select_next_skill,
)
from interview_os.core.readiness import (
    build_readiness_graph,
    compute_skill_readiness,
    confidence_for_weight,
    status_for_score,
)
from interview_os.core.resources import builtin_resources_for, merge_resources
from interview_os.core.rounds import in_round, round_fallback_requirements
from interview_os.core.state_machine import (
    can_transition,
    next_events,
    transition,
)
from interview_os.core.voice import count_fillers, voice_feedback

REPO_ROOT = Path(__file__).resolve().parents[3]
GOLDEN_DIR = REPO_ROOT / "tests" / "golden"

AREA_FILES = (
    "readiness.json",
    "gaps.json",
    "prioritize.json",
    "state-machine.json",
    "taxonomy.json",
    "rounds.json",
    "voice.json",
    "resources.json",
)

Case = dict[str, Any]


class MappedTaxonomy:
    """The `taxonomy` input spec from a golden case, as a `TaxonomyLike`."""

    def __init__(self, spec: Mapping[str, Any]) -> None:
        parent_of = spec.get("parentOf") or {}
        label_for = spec.get("labelFor") or {}
        children_of = spec.get("childrenOf") or {}
        self._parent: dict[str, str] = {str(k): str(v) for k, v in parent_of.items()}
        self._labels: dict[str, str] = {str(k): str(v) for k, v in label_for.items()}
        self._children: dict[str, list[str]] = {
            str(k): [str(child) for child in v] for k, v in children_of.items()
        }

    def parent_of(self, skill_id: str) -> str | None:
        return self._parent.get(skill_id)

    def label_for(self, skill_id: str) -> str:
        return self._labels.get(skill_id, skill_id)

    def children_of(self, skill_id: str) -> list[str]:
        return list(self._children.get(skill_id, []))


def _evidence(raw: object) -> list[Evidence]:
    return [Evidence.model_validate(item) for item in _as_list(raw)]


def _requirements(raw: object) -> list[Requirement]:
    return [Requirement.model_validate(item) for item in _as_list(raw)]


def _readiness(raw: object) -> dict[str, SkillReadiness]:
    assert isinstance(raw, Mapping)
    return {str(key): SkillReadiness.model_validate(value) for key, value in raw.items()}


def _resources(raw: object) -> list[PrepResource]:
    return [PrepResource.model_validate(item) for item in _as_list(raw)]


def _as_list(raw: object) -> list[Any]:
    assert isinstance(raw, list)
    return list(raw)


def _optional_float(raw: object) -> float | None:
    if raw is None:
        return None
    assert isinstance(raw, (int, float)) and not isinstance(raw, bool)
    return float(raw)


def _number(raw: object) -> float:
    assert isinstance(raw, (int, float)) and not isinstance(raw, bool)
    return float(raw)


def _text(raw: object) -> str:
    assert isinstance(raw, str)
    return raw


def _jsonable(value: object) -> object:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True)
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    return value


def _without_none(value: object) -> object:
    """TS-optional PrepResource fields (`url`, `summary`) are absent when unset."""

    if isinstance(value, dict):
        return {key: _without_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_without_none(item) for item in value]
    return value


def _resource_output(resources: Sequence[PrepResource]) -> object:
    return _without_none(_jsonable(list(resources)))


RUNNERS: dict[str, Callable[[Case], object]] = {
    # readiness
    "statusForScore": lambda i: status_for_score(_optional_float(i.get("score"))),
    "confidenceForWeight": lambda i: confidence_for_weight(_number(i["totalWeight"])),
    "computeSkillReadiness": lambda i: compute_skill_readiness(
        _evidence(i["evidence"]), parse_iso_datetime(_text(i["now"]))
    ),
    "buildReadinessGraph": lambda i: build_readiness_graph(
        evidence=_evidence(i.get("evidence") or []),
        requirements=_requirements(i.get("requirements") or []),
        taxonomy=MappedTaxonomy(i["taxonomy"]) if i.get("taxonomy") else None,
        now=parse_iso_datetime(_text(i["now"])),
    ),
    # gaps
    "calculateGaps": lambda i: calculate_gaps(
        requirements=_requirements(i.get("requirements") or []),
        readiness=_readiness(i["readiness"]),
        level=Level(_text(i["level"])),
    ),
    # prioritize
    "difficultyFor": lambda i: difficulty_for(
        Level(_text(i["level"])), _optional_float(i.get("score"))
    ),
    "selectNextSkill": lambda i: select_next_skill(SelectNextSkillInput.model_validate(i)),
    # state machine
    "transition": lambda i: transition(
        InterviewStatus(_text(i["status"])), InterviewEvent(_text(i["event"]))
    ),
    "canTransition": lambda i: can_transition(
        InterviewStatus(_text(i["status"])), InterviewEvent(_text(i["event"]))
    ),
    "nextEvents": lambda i: next_events(InterviewStatus(_text(i["status"]))),
    # taxonomy
    "allNodes": lambda i: taxonomy.all_nodes(),
    "getNode": lambda i: taxonomy.get_node(_text(i["id"])),
    "hasNode": lambda i: taxonomy.has_node(_text(i["id"])),
    "parentOf": lambda i: taxonomy.parent_of(_text(i["id"])),
    "ancestors": lambda i: taxonomy.ancestors(_text(i["id"])),
    "childrenOf": lambda i: taxonomy.children_of(_text(i["id"])),
    "relatedTo": lambda i: taxonomy.related_to(_text(i["id"])),
    "labelFor": lambda i: taxonomy.label_for(_text(i["id"])),
    "normalizeSkillId": lambda i: taxonomy.normalize_skill_id(_text(i["raw"])),
    "matchSkills": lambda i: taxonomy.match_skills(_text(i["text"])),
    # rounds
    "inRound": lambda i: in_round(_text(i["skillId"]), _text(i["roundType"])),
    "roundFallbackRequirements": lambda i: round_fallback_requirements(_text(i["roundType"])),
    # voice
    "countFillers": lambda i: count_fillers(_text(i["text"])),
    "voiceFeedback": lambda i: voice_feedback(i["metrics"], _text(i["transcript"])),
    # resources
    "builtinResourcesFor": lambda i: _resource_output(builtin_resources_for(_text(i["skillId"]))),
    "mergeResources": lambda i: _resource_output(
        merge_resources(*(_resources(list_) for list_ in _as_list(i["lists"])))
    ),
}


def _load_cases() -> list[tuple[str, Case]]:
    loaded: list[tuple[str, Case]] = []
    for filename in AREA_FILES:
        path = GOLDEN_DIR / filename
        document = json.loads(path.read_text(encoding="utf-8"))
        assert document["generatedFrom"] == "packages/core"
        for case in document["cases"]:
            loaded.append((document["area"], case))
    return loaded


ALL_CASES = _load_cases()
GOLDEN_IDS = [f"{area}:{case['fn']}:{case['name']}" for area, case in ALL_CASES]


def _mismatch(path: str, expected: object, actual: object) -> AssertionError:
    return AssertionError(
        f"{path}: expected {expected!r} ({type(expected).__name__}), "
        f"got {actual!r} ({type(actual).__name__})"
    )


def _assert_matches(actual: object, expected: object, path: str) -> None:
    if expected is None:
        if actual is not None:
            raise _mismatch(path, expected, actual)
        return
    if isinstance(expected, bool):
        if actual is not expected:
            raise _mismatch(path, expected, actual)
        return
    if isinstance(expected, int):
        if isinstance(actual, bool) or not isinstance(actual, (int, float)) or actual != expected:
            raise _mismatch(path, expected, actual)
        return
    if isinstance(expected, float):
        if isinstance(actual, bool) or not isinstance(actual, (int, float)):
            raise _mismatch(path, expected, actual)
        if not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12):
            raise _mismatch(path, expected, actual)
        return
    if isinstance(expected, str):
        if not isinstance(actual, str) or actual != expected:
            raise _mismatch(path, expected, actual)
        return
    if isinstance(expected, list):
        if not isinstance(actual, list):
            raise _mismatch(path, expected, actual)
        if len(actual) != len(expected):
            raise AssertionError(f"{path}: expected {len(expected)} items, got {len(actual)}")
        for index, item in enumerate(expected):
            _assert_matches(actual[index], item, f"{path}[{index}]")
        return
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            raise _mismatch(path, expected, actual)
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        if missing or extra:
            raise AssertionError(f"{path}: key mismatch (missing={missing}, extra={extra})")
        for key, item in expected.items():
            _assert_matches(actual[key], item, f"{path}.{key}")
        return
    raise AssertionError(f"{path}: unsupported expected type {type(expected).__name__}")


def _constraint_text(issue: Mapping[str, Any]) -> str:
    code = issue["code"]
    if code in ("too_small", "too_big"):
        bound = issue["minimum"] if code == "too_small" else issue["maximum"]
        comparison = ">=" if code == "too_small" else "<="
        if not issue["inclusive"]:
            comparison = comparison[0]
        return f"{comparison} {bound}"
    raise AssertionError(f"unsupported Zod error code in fixture: {code}")


def _assert_zod_error(recorded_message: str, error: Exception) -> None:
    """Match failing field paths + constraint kinds of the recorded Zod issues."""

    if not isinstance(error, ValidationError):
        raise AssertionError(
            f"expected a Pydantic ValidationError, got {type(error).__name__}: {error}"
        )
    issues = json.loads(recorded_message)
    errors = error.errors()
    assert len(errors) == len(issues), f"expected {len(issues)} issues, got {len(errors)}"
    expected_kinds = {
        ">=": "greater than or equal to",
        ">": "greater than",
        "<=": "less than or equal to",
        "<": "less than",
    }
    for issue, actual in zip(issues, errors, strict=True):
        assert list(actual["loc"]) == list(issue["path"]), (
            f"field path mismatch: expected {issue['path']}, got {list(actual['loc'])}"
        )
        constraint = _constraint_text(issue)
        kind = expected_kinds[constraint.split(" ")[0]]
        assert kind in actual["msg"], f"expected {kind!r} in {actual['msg']!r}"
        bound = issue["minimum"] if "minimum" in issue else issue["maximum"]
        assert str(bound) in actual["msg"], f"expected bound {bound!r} in {actual['msg']!r}"


@pytest.mark.parametrize(("area", "case"), ALL_CASES, ids=GOLDEN_IDS)
def test_golden(area: str, case: Case) -> None:
    runner = RUNNERS[case["fn"]]
    expected_error = case.get("error")
    if expected_error is None:
        output = _jsonable(runner(case["input"]))
        _assert_matches(output, case["output"], f"{area}:{case['name']}")
        return
    with pytest.raises(Exception) as excinfo:
        runner(case["input"])
    error = excinfo.value
    if expected_error["name"] == "ZodError":
        _assert_zod_error(expected_error["message"], error)
    else:
        assert type(error).__name__ == expected_error["name"], (
            f"expected {expected_error['name']}, got {type(error).__name__}"
        )
        assert str(error) == expected_error["message"]


def test_golden_case_count() -> None:
    # 428 cases across the 8 area files (the task brief said 427; the files
    # themselves sum to 428 — verified with a direct count of every file).
    assert len(ALL_CASES) == 428


def test_golden_areas_covered() -> None:
    assert {area for area, _ in ALL_CASES} == {name.removesuffix(".json") for name in AREA_FILES}
