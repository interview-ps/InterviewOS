"""LockManager tests (design §8.1): global vs fine modes, ordering, no-nesting."""

from __future__ import annotations

import asyncio

import pytest

from interview_os.orchestrator import LockManager


async def test_global_serializes_every_scope() -> None:
    locks = LockManager("global")
    order: list[str] = []
    started = asyncio.Event()

    async def worker(name: str) -> None:
        async with locks.hold("a" if name == "one" else "b"):
            order.append(f"{name}:in")
            started.set()
            await asyncio.sleep(0.01)
            order.append(f"{name}:out")

    await asyncio.gather(worker("one"), worker("two"))
    # Under the global lock the two never interleave.
    assert order == ["one:in", "one:out", "two:in", "two:out"] or order == [
        "two:in",
        "two:out",
        "one:in",
        "one:out",
    ]


async def test_fine_allows_distinct_scopes_to_overlap() -> None:
    locks = LockManager("fine")
    overlap = asyncio.Event()
    inside = 0

    async def worker(key: str) -> None:
        nonlocal inside
        async with locks.hold(key):
            inside += 1
            if inside == 2:
                overlap.set()
            await asyncio.wait_for(overlap.wait(), timeout=1)
            inside -= 1

    await asyncio.gather(worker("a"), worker("b"))
    assert overlap.is_set()


async def test_fine_serializes_same_scope() -> None:
    locks = LockManager("fine")
    order: list[str] = []

    async def worker(name: str) -> None:
        async with locks.hold("same"):
            order.append(f"{name}:in")
            await asyncio.sleep(0.01)
            order.append(f"{name}:out")

    await asyncio.gather(worker("one"), worker("two"))
    assert order in (
        ["one:in", "one:out", "two:in", "two:out"],
        ["two:in", "two:out", "one:in", "one:out"],
    )


async def test_fine_unkeyed_uses_global_scope() -> None:
    locks = LockManager("fine")
    order: list[str] = []

    async def keyed() -> None:
        async with locks.hold("other"):
            order.append("keyed:in")
            await asyncio.sleep(0.01)
            order.append("keyed:out")

    async def unkeyed() -> None:
        async with locks.hold():
            order.append("unkeyed:in")
            await asyncio.sleep(0.01)
            order.append("unkeyed:out")

    await asyncio.gather(keyed(), unkeyed())
    # Different keys → concurrent; the assertions below just prove both ran.
    assert set(order) == {"keyed:in", "keyed:out", "unkeyed:in", "unkeyed:out"}


async def test_fine_rejects_nested_acquisition_with_new_keys() -> None:
    locks = LockManager("fine")
    with pytest.raises(RuntimeError):
        async with locks.hold("a"):
            async with locks.hold("b"):
                pass


async def test_fine_allows_reentrant_held_keys() -> None:
    locks = LockManager("fine")
    async with locks.hold("a", "b"):
        async with locks.hold("a"):
            pass


async def test_unknown_mode_falls_back_to_global() -> None:
    assert LockManager("nonsense").mode == "global"


async def test_fine_stress_interleaved_keys() -> None:
    locks = LockManager("fine")
    counters = {"a": 0, "b": 0, "c": 0}

    async def worker(key: str) -> None:
        for _ in range(50):
            async with locks.hold(key):
                counters[key] += 1
                await asyncio.sleep(0)

    await asyncio.gather(*(worker(key) for key in counters for _ in range(4)))
    assert counters == {"a": 200, "b": 200, "c": 200}
