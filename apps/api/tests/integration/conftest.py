"""Fixtures for the orchestrator integration suites (phase 5b)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from interview_os.ai.logger import NullLogger
from interview_os.ai.mock import MockRuntime
from interview_os.core import taxonomy
from interview_os.orchestrator import InterviewOrchestrator, OrchestratorDeps
from interview_os.skills import register_mock_handlers
from interview_os.store import Store, open_store

REPO_ROOT = Path(__file__).resolve().parents[4]
EXAMPLES_DIR = REPO_ROOT / "examples"


@dataclass
class App:
    orchestrator: InterviewOrchestrator
    store: Store


def load_example(name: str) -> dict[str, str]:
    directory = EXAMPLES_DIR / name
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    return {
        **meta,
        "resumeText": (directory / "resume.md").read_text(encoding="utf-8"),
        "jobDescription": (directory / "job.md").read_text(encoding="utf-8"),
    }


@pytest.fixture
def app() -> Iterator[App]:
    store = open_store(":memory:")
    runtime = MockRuntime()
    register_mock_handlers(runtime)
    orchestrator = InterviewOrchestrator(
        OrchestratorDeps(store=store, runtime=runtime, logger=NullLogger())
    )
    try:
        yield App(orchestrator=orchestrator, store=store)
    finally:
        store.close()


@pytest.fixture(autouse=True)
def _restore_taxonomy() -> Iterator[None]:
    nodes = dict(taxonomy._nodes)
    children = {key: set(value) for key, value in taxonomy._children_index.items()}
    alias_index = taxonomy._alias_index
    yield
    taxonomy._nodes.clear()
    taxonomy._nodes.update(nodes)
    taxonomy._children_index.clear()
    taxonomy._children_index.update(children)
    taxonomy._alias_index = alias_index
