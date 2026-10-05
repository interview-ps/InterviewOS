"""Interview-skill mock handlers — ports of `skills/interview/*/mock.ts`."""

from __future__ import annotations

from ...core import taxonomy
from ...plugins.testing.mock_helpers import generic_interviewer_mock

__all__ = ["interviewer_mock"]


def interviewer_mock(input: object) -> object:
    """Deterministic mock for the host's `interviewer` task ("mixed" + practice).

    The host injects the taxonomy node's keywords for the generic-prompt path.
    """
    data = dict(input) if isinstance(input, dict) else {}
    node = taxonomy.get_node(str(data.get("skillId", "")))
    return generic_interviewer_mock(
        {**data, "skillKeywords": list(node.keywords) if node is not None else []}
    )
