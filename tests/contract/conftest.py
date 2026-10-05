"""Contract suite fixtures.

Black-box only: the suite speaks HTTP to whatever `server`/`base_url` points
at. Snapshots live under fixtures/<test_module>/<test_name>.json; record with
`pytest --record` or CONTRACT_RECORD=1.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from harness import coverage
from harness.normalize import Normalizer, default_normalizer
from harness.server import (
    REPO_ROOT,
    SPAWNED_TMPDIRS,
    ServerHandle,
    launch_server,
    stop_server,
    tail_log,
)
from harness.snapshot import FIXTURES_DIR, Snapshot, sanitize_name
from harness.sse import SSEStream

TEST_DIR = Path(__file__).resolve().parent

_FAILED = pytest.StashKey[bool]()


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--record",
        action="store_true",
        default=False,
        help="record response snapshots into fixtures/ instead of comparing",
    )


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[Any]):
    rep = yield
    if rep.when == "call":
        item.stash[_FAILED] = rep.failed
    return rep


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    if exitstatus != 0:
        handle = getattr(session.config, "_contract_server", None)
        if isinstance(handle, ServerHandle) and handle.spawned:
            print(f"\n--- last 50 lines of {handle.log_path} ---\n{tail_log(handle.log_path)}")


class ContractClient:
    """httpx wrapper that substitutes {placeholders} and records coverage."""

    def __init__(self, base_url: str, timeout: float = 120.0) -> None:
        self.base_url = base_url
        self._http = httpx.Client(base_url=base_url, timeout=timeout)

    def request(
        self,
        method: str,
        template: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        content: bytes | str | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        **path_params: Any,
    ) -> httpx.Response:
        url = template.format(**path_params) if path_params else template
        coverage.record(method, template)
        return self._http.request(
            method,
            url,
            params=params,
            json=json,
            content=content,
            data=data,
            files=files,
            headers=headers,
        )

    def get(self, template: str, **kw: Any) -> httpx.Response:
        return self.request("GET", template, **kw)

    def post(self, template: str, **kw: Any) -> httpx.Response:
        return self.request("POST", template, **kw)

    def put(self, template: str, **kw: Any) -> httpx.Response:
        return self.request("PUT", template, **kw)

    def patch(self, template: str, **kw: Any) -> httpx.Response:
        return self.request("PATCH", template, **kw)

    def delete(self, template: str, **kw: Any) -> httpx.Response:
        return self.request("DELETE", template, **kw)

    def stream(self, method: str, template: str, **kw: Any) -> SSEStream:
        """Open an SSE stream (adds ?stream=1). Use as a context manager."""
        path_params = kw.pop("path_params", {})
        url = template.format(**path_params) if path_params else template
        coverage.record(method, template)
        params = {"stream": "1", **(kw.pop("params", None) or {})}
        cm = self._http.stream(method, url, params=params, **kw)
        return SSEStream(cm)


@pytest.fixture(scope="session")
def server(tmp_path_factory: pytest.TempPathFactory, pytestconfig: pytest.Config):
    handle = launch_server(tmp_path_factory.mktemp("contract-server"))
    pytestconfig._contract_server = handle  # for the sessionfinish log tail
    yield handle
    stop_server(handle)


@pytest.fixture(scope="session")
def base_url(server: ServerHandle) -> str:
    return server.base_url


@pytest.fixture(autouse=True)
def _reset(base_url: str) -> None:
    """Function-scoped isolation via the test-mode reset endpoint."""
    resp = httpx.post(f"{base_url}/api/test/reset", timeout=30.0)
    assert resp.status_code == 200, f"test reset failed: {resp.status_code} {resp.text[:200]}"


@pytest.fixture
def client(base_url: str) -> Iterator[ContractClient]:
    c = ContractClient(base_url)
    yield c
    c._http.close()


@pytest.fixture
def normalizer() -> Normalizer:
    return default_normalizer(REPO_ROOT, SPAWNED_TMPDIRS)


@pytest.fixture
def snapshot(request: pytest.FixtureRequest, normalizer: Normalizer) -> Iterator[Snapshot]:
    module = sanitize_name(request.module.__name__)
    name = sanitize_name(request.node.name)
    record = bool(request.config.getoption("--record")) or os.environ.get(
        "CONTRACT_RECORD"
    ) == "1"
    snap = Snapshot(FIXTURES_DIR / module / f"{name}.json", record, normalizer)
    yield snap
    snap.finish(bool(request.node.stash.get(_FAILED, True)))


# --------------------------------------------------------------------------
# Shared flow helpers (black-box: pure HTTP against the example fixtures)


def load_example(client: ContractClient, name: str = "backend-engineer") -> dict[str, Any]:
    resp = client.get("/api/examples/{name}", name=name)
    assert resp.status_code == 200, resp.text
    return resp.json()


def setup_workspace(client: ContractClient, name: str = "backend-engineer") -> dict[str, Any]:
    """POST /api/workspace/setup with the bundled example; returns the body."""
    ex = load_example(client, name)
    resp = client.post(
        "/api/workspace/setup",
        json={
            "resumeText": ex["resumeText"],
            "jobDescription": ex["jobDescription"],
            "company": ex["company"],
            "role": ex["role"],
            "level": ex["level"],
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
def workspace(client: ContractClient) -> dict[str, Any]:
    """A workspace built from examples/backend-engineer (resume + JD)."""
    return setup_workspace(client)


def run_session_to_debrief(client: ContractClient, session_id: str, max_steps: int = 12) -> None:
    """Drive an interview to `debrief`: answer questions, advance follow-ups,
    complete. Mirrors the canonical feedback-loop driver."""
    for _ in range(max_steps):
        cur = client.get("/api/interviews/{id}", id=session_id).json()
        status = cur["session"]["status"]
        if status in ("complete", "debrief"):
            break
        if status == "follow_up":
            nq = client.post("/api/interviews/{id}/next", id=session_id).json()
            if nq.get("question") is None:
                break
        elif status == "question":
            q = cur["questions"][-1]
            client.post(
                "/api/interviews/{id}/answer",
                id=session_id,
                json={
                    "answer": (
                        f"For {q.get('topic', 'this topic')}: I would define clear "
                        "ownership, name the trade-offs, and describe validation "
                        "criteria; in practice I combine a ttl with explicit "
                        "invalidation on writes."
                    )
                },
            )
    client.post("/api/interviews/{id}/complete", id=session_id)


def wait_for(predicate, timeout_s: float = 30.0, interval_s: float = 0.25):
    """Poll `predicate` (a zero-arg callable) until truthy; returns its value."""
    deadline = time.monotonic() + timeout_s
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() > deadline:
            raise TimeoutError("condition not met within timeout")
        time.sleep(interval_s)
