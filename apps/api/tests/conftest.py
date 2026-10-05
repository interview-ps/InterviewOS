"""Shared fixtures: repo paths, temporary stores, and the Node probe."""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest

from interview_os.store import Store, open_store

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLES_DIR = REPO_ROOT / "examples"
CONTRACT_ROUTES = REPO_ROOT / "tests" / "contract" / "routes.json"


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def examples_dir() -> Path:
    return EXAMPLES_DIR


@pytest.fixture
def memory_store() -> Iterator[Store]:
    store = open_store(":memory:")
    try:
        yield store
    finally:
        store.close()


@pytest.fixture
def file_store(tmp_path: Path) -> Iterator[Store]:
    store = open_store(tmp_path / "interview-os.db")
    try:
        yield store
    finally:
        store.close()


@pytest.fixture(scope="session")
def node_executable() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not on PATH — cannot generate the server's DDL")
    return node
