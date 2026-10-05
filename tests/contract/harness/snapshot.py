"""Record/compare JSON snapshots.

`pytest --record` (or CONTRACT_RECORD=1) writes `fixtures/<module>/<test>.json`;
the default mode compares and fails with a readable diff. A test may snapshot
several responses — each is stored under a label inside one file.
"""

from __future__ import annotations

import difflib
import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from .normalize import Normalizer, dumps_normalized

FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"


def sanitize_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name)


def payload_for(response: httpx.Response, normalizer: Normalizer) -> dict[str, Any]:
    """What a real client depends on: status code + normalized body.

    JSON bodies are normalized as JSON; anything else (yaml exports, frame
    HTML, asset bytes) is kept as normalized text with its content-type.
    """
    content_type = response.headers.get("content-type", "")
    out: dict[str, Any] = {"status": response.status_code}
    if "json" in content_type:
        out["body"] = normalizer.normalize(response.json())
    else:
        out["contentType"] = content_type.split(";")[0]
        out["body"] = normalizer.normalize(response.text)
    return out


class Snapshot:
    """Bound to one test; persists to fixtures/<module>/<test>.json."""

    def __init__(self, path: Path, record: bool, normalizer: Normalizer) -> None:
        self.path = path
        self.record = record
        self.normalizer = normalizer
        self._checked: list[str] = []
        self._written: dict[str, Any] = {}
        self._file: dict[str, Any] | None = None
        if not record and path.exists():
            self._file = json.loads(path.read_text(encoding="utf-8")).get("snapshots", {})

    def check(self, label: str, value: Any) -> None:
        normalized = self.normalizer.normalize(value)
        self._checked.append(label)
        if self.record:
            self._write(label, normalized)
            return
        if self._file is None:
            pytest.fail(
                f"no snapshot file {self.path} — run `pytest --record` first",
                pytrace=False,
            )
        if label not in self._file:
            pytest.fail(
                f"snapshot {label!r} missing from {self.path} — run `pytest --record`",
                pytrace=False,
            )
        expected = self._file[label]
        if expected != normalized:
            diff = "\n".join(
                difflib.unified_diff(
                    json.dumps(expected, indent=2, sort_keys=True).splitlines(),
                    json.dumps(normalized, indent=2, sort_keys=True).splitlines(),
                    fromfile="fixture",
                    tofile="actual",
                    lineterm="",
                )
            )
            pytest.fail(f"snapshot {label!r} mismatch in {self.path.name}:\n{diff}", pytrace=False)

    def check_response(self, label: str, response: httpx.Response) -> dict[str, Any]:
        """Snapshot status+body; returns the normalized payload for asserts."""
        payload = payload_for(response, self.normalizer)
        self.check(label, payload)
        return payload

    def _write(self, label: str, value: Any) -> None:
        # Start from an empty snapshot map per test: labels from an older
        # version of the test must not survive re-recording.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._written[label] = value
        self.path.write_text(
            dumps_normalized({"snapshots": self._written}), encoding="utf-8"
        )

    def finish(self, test_failed: bool) -> None:
        """In compare mode, fail if the fixture has labels this test did not
        produce (keeps recorded files in lockstep with the test)."""
        if self.record or test_failed or self._file is None:
            return
        extra = sorted(set(self._file) - set(self._checked))
        missing = sorted(set(self._checked) - set(self._file))
        if extra or missing:
            pytest.fail(
                f"snapshot labels out of sync in {self.path.name}: "
                f"unused={extra} missing={missing} — run `pytest --record`",
                pytrace=False,
            )
