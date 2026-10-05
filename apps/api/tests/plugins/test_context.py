"""`PluginContext` — kind checks and the load conversion (phase-7 §2)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import pytest

from interview_os.core.models import EvidenceProposal, InterviewOSState
from interview_os.plugins import PluginContext, PluginManifest


def manifest_for(kind: str, plugin_id: str = "demo") -> PluginManifest:
    return PluginManifest.model_validate({"id": plugin_id, "version": "1.0.0", "kind": kind})


def ctx_for(kind: str, plugin_dir: Path, plugin_id: str = "demo") -> PluginContext:
    plugin_dir.mkdir(parents=True, exist_ok=True)
    return PluginContext(manifest_for(kind, plugin_id), plugin_dir)


# ------------------------------------------------------------------- tool plugin


def test_tool_registration_records_metadata(tmp_path: Path) -> None:
    ctx = ctx_for("tool", tmp_path / "tool")
    ctx.tool("add", lambda a, b: a + b, description="adds", config_fields=[{"name": "a"}])
    loaded = ctx.to_loaded()
    assert len(loaded.tools) == 1
    assert loaded.tools[0].name == "add"
    assert loaded.tools[0].description == "adds"
    assert loaded.tools[0].config_fields == [{"name": "a"}]
    assert loaded.context is ctx
    assert loaded.source_path == tmp_path / "tool"


def test_tool_requires_a_callable(tmp_path: Path) -> None:
    ctx = ctx_for("tool", tmp_path / "tool")
    with pytest.raises(ValueError):
        ctx.tool("nope", cast(Any, 42))


# ---------------------------------------------------------------- kind checking


def test_skills_is_rejected_for_tool_and_hook(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        ctx_for("tool", tmp_path / "tool").skills("skills")
    with pytest.raises(ValueError):
        ctx_for("hook", tmp_path / "hook").skills("skills")


def test_middleware_is_rejected_for_tool_and_skill(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        ctx_for("tool", tmp_path / "tool").middleware(object())
    with pytest.raises(ValueError):
        ctx_for("skill", tmp_path / "skill").middleware(object())


def test_tool_is_rejected_for_skill_and_hook(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        ctx_for("skill", tmp_path / "skill").tool("add", lambda: 1)
    with pytest.raises(ValueError):
        ctx_for("hook", tmp_path / "hook").tool("add", lambda: 1)


# ------------------------------------------------------------------ skill plugin


def test_skills_dir_records_and_warns_when_missing(tmp_path: Path) -> None:
    ctx = ctx_for("skill", tmp_path / "skill")
    ctx.skills("skills")
    loaded = ctx.to_loaded()
    assert loaded.skills_dir == (tmp_path / "skill" / "skills").resolve()
    assert any("missing" in message for message in loaded.diagnostics)

    skills = tmp_path / "skill" / "skills" / "greet"
    skills.mkdir(parents=True)
    ctx2 = ctx_for("skill", tmp_path / "skill")
    ctx2.skills("skills")
    assert ctx2.to_loaded().diagnostics == []


def test_skills_traversal_is_a_diagnostic_not_a_crash(tmp_path: Path) -> None:
    ctx = ctx_for("skill", tmp_path / "skill")
    ctx.skills("../outside")
    loaded = ctx.to_loaded()
    assert loaded.skills_dir is None
    assert any("outside" in message for message in loaded.diagnostics)


# ------------------------------------------------------------------- hook plugin


def test_middleware_records_priority(tmp_path: Path) -> None:
    ctx = ctx_for("hook", tmp_path / "hook")
    first = object()
    second = object()
    ctx.middleware(first, priority=5)
    ctx.middleware(second)
    loaded = ctx.to_loaded()
    assert [entry.priority for entry in loaded.middleware] == [5, 100]
    assert loaded.middleware[0].plugin_id == "demo"
    assert loaded.middleware[1].instance is second


# ---------------------------------------------------------------- runtime / state


def test_runtime_is_none_until_bound(tmp_path: Path) -> None:
    ctx = ctx_for("tool", tmp_path / "tool")
    assert ctx.runtime is None
    sentinel = cast(Any, object())
    ctx.bind_runtime(sentinel)
    assert ctx.runtime is sentinel


def test_state_reader_is_empty_by_default(tmp_path: Path) -> None:
    reader = ctx_for("tool", tmp_path / "tool").state
    assert reader.is_empty is True
    assert reader.candidate is None
    assert reader.target is None
    assert reader.readiness is None
    assert reader.snapshot() is None


def test_state_reader_exposes_bound_slices(tmp_path: Path) -> None:
    candidate = object()
    state = InterviewOSState.model_construct(
        candidate=candidate,
        target=None,
        assessment=None,
        preparation=None,
        interview=None,
        readiness=None,
    )
    ctx = ctx_for("tool", tmp_path / "tool")
    ctx.bind_state(state)
    reader = ctx.state
    assert reader.is_empty is False
    assert cast(object, reader.candidate) is candidate
    assert reader.target is None


# --------------------------------------------------------------------- evidence


def test_evidence_enqueues_and_notifies_the_sink(tmp_path: Path) -> None:
    ctx = ctx_for("hook", tmp_path / "hook")
    seen: list[EvidenceProposal] = []
    ctx.bind_evidence_sink(seen.append)
    proposal = EvidenceProposal(skill_id="sql", score=0.5, confidence=0.5, observation="ok")
    ctx.evidence(proposal)
    assert seen == [proposal]
    assert ctx.drain_evidence() == [proposal]
    assert ctx.drain_evidence() == []
