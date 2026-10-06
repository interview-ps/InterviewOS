"""Deterministic normalization for contract snapshots.

Deep-walks decoded JSON/text and masks values that are legitimately
nondeterministic so that a recorded fixture can be compared byte-for-byte
against a later run (or a different backend). Every mask applied is listed in
MASKS below with the reason it is needed.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

# Entity ids look like `sess_9f2c…` / `act_…` (prefix_uuid). They are remapped
# to `<prefix#N>` numbered by first appearance *within a single test* so that
# cross-references (e.g. answer.questionId ↔ question.id) stay verifiable.
_ID_RE = re.compile(
    r"^([a-z][a-z0-9_]*)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12}$"
)

# ISO-8601 timestamps — every *At field, export dates, etc.
_TS_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$"
)

# Mock runtime thread ids are a per-process counter (`mock-thread-7`): the
# value depends on how many sessions ran earlier in the suite, so it is not
# stable under reordering or partial runs.
_MOCK_THREAD_RE = re.compile(r"mock-thread-\d+")

# The plugin UI frame document embeds the request origin (`http://127.0.0.1:
# <port>`). The port is chosen dynamically per server spawn.
_PORT_RE = re.compile(r"((?:127\.0\.0\.1|localhost|\[::1\])):\d{2,5}")

# Per-request CSP nonce in the frame document — random every render.
_NONCE_RE = re.compile(r'nonce="[^"]+"')

# Keys whose values are wall-clock measurements — never meaningful parity.
_DURATION_KEYS = frozenset({"durationMs", "durationMillis", "elapsedMs", "latencyMs"})

# Integer `id`/`rowid`/`seq` values are SQLite rowids — they depend on how many
# rows were written earlier in the server session, so they are positional, not
# contractual (e.g. readiness snapshot history ids).
_ROWID_KEYS = frozenset({"id", "rowid", "seq"})

# Scores/confidences/uncertainties embed millisecond timing of evidence writes
# (recency decay), which shifts them by ~1e-9 between runs, plus ordinary IEEE
# accumulation noise (0.9 vs 0.8999999999999999). Rounding to 6 decimals keeps
# contract-meaningful differences (≥1e-6) while absorbing that noise.
_FLOAT_DECIMALS = 6


def canonical_newlines(value: str) -> str:
    """Collapse CRLF to LF.

    Line endings are a *checkout* artifact, not part of the contract: the same
    `examples/*.md` file is CRLF on a Windows checkout and LF on Linux/CI, and
    the API stores and returns the text verbatim. Comparing on LF only means a
    fixture recorded on either platform validates on both.
    """
    return value.replace("\r\n", "\n")


class Normalizer:
    """Per-test normalizer: id numbering restarts for each test."""

    def __init__(self, extra_substrings: list[tuple[str, str]] | None = None) -> None:
        self._ids: dict[str, str] = {}
        self._counts: dict[str, int] = {}
        # Order matters: longest/most-specific replacements first.
        self._substrings: list[tuple[str, str]] = list(extra_substrings or [])

    def _map_id(self, value: str, prefix: str) -> str:
        if value not in self._ids:
            self._counts[prefix] = self._counts.get(prefix, 0) + 1
            self._ids[value] = f"<{prefix}#{self._counts[prefix]}>"
        return self._ids[value]

    def _string(self, value: str) -> str:
        m = _ID_RE.match(value)
        if m:
            return self._map_id(value, m.group(1))
        if _TS_RE.match(value):
            return "<ts>"
        value = canonical_newlines(value)
        masked_path = False
        for needle, repl in self._substrings:
            if needle and needle in value:
                value = value.replace(needle, repl)
                masked_path = True
        if masked_path:
            # Whatever follows a masked repo/tmp/node path is a path too, and the
            # separator is the recording platform's, not the API's: `E:\...` →
            # `<repo>` leaves `\tests\fixtures\...` on Windows but
            # `/tests/fixtures/...` on Linux/CI.
            value = value.replace("\\", "/")
        value = _MOCK_THREAD_RE.sub("<mock-thread>", value)
        value = _PORT_RE.sub(r"\1:<port>", value)
        value = _NONCE_RE.sub('nonce="<nonce>"', value)
        return value

    def normalize(self, obj: Any, _key: str | None = None) -> Any:
        if isinstance(obj, dict):
            return {
                self._string(k) if isinstance(k, str) else k: self.normalize(v, k)
                for k, v in obj.items()
            }
        if isinstance(obj, list):
            return [self.normalize(v, _key) for v in obj]
        if isinstance(obj, str):
            return self._string(obj)
        if isinstance(obj, bool):
            return obj
        if isinstance(obj, (int, float)) and _key in _DURATION_KEYS:
            return "<duration>"
        if isinstance(obj, int) and _key in _ROWID_KEYS:
            return "<rowid>"
        if isinstance(obj, float):
            return round(obj, _FLOAT_DECIMALS)
        return obj


def default_normalizer(
    repo_root: Path, tmpdirs: list[Path] | tuple[Path, ...] = ()
) -> Normalizer:
    """Normalizer seeded with the environment-specific path masks.

    - repo_root → `<repo>`: absolute paths leak into plugin views (dir/source),
      error messages and frame documents.
    - each tmpdir → `<tmp>`: per-run temp dirs (db path, installed plugin/pack
      dirs) can appear in views and error messages. Several servers may be
      spawned per session (module-scoped isolation), so all are masked.
    - the Node executable → `<node>`: the harness puts `shutil.which("node")`
      into the MCP server config, and MCP views echo the config back — the path
      is the runner image's (`/opt/hostedtoolcache/...` on CI,
      `C:\\Program Files\\nodejs\\node.EXE` on a Windows dev box).
    Both paths are masked with `/` and `\\` separator variants.
    """
    subs: list[tuple[str, str]] = []
    paths: list[tuple[str | None, str]] = [
        (str(repo_root), "<repo>"),
        *((str(t), "<tmp>") for t in tmpdirs),
        (shutil.which("node"), "<node>"),
    ]
    for path, tag in paths:
        if path is None:
            continue
        subs.append((path, tag))
        posix = path.replace("\\", "/")
        if posix != path:
            subs.append((posix, tag))
    return Normalizer(subs)


def dumps_normalized(value: Any) -> str:
    """Stable, readable serialization for fixture files (keys sorted)."""
    import json

    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
