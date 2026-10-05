# Phase 9 — fine-grained locks

Status: **primitive landed; keying + default flip remain.**

## Done

- **`LockManager` supports `global` and `fine`** (design §8.1), in
  `orchestrator/orchestrator.py`:
  - `global` (default): one lock for every scope — the parity mode.
  - `fine`: one `asyncio.Lock` per scope key, acquired in a **total order**
    (sorted keys) so concurrent acquisitions cannot deadlock; an unkeyed call
    maps to the `global` key (still serializes with everything); an unknown
    `INTERVIEW_OS_LOCK_MODE` falls back to `global`.
  - **No-nesting guard**: a nested `hold()` with new keys raises; re-entering
    only already-held keys is allowed (a contextvar tracks held keys).
- Tests (`tests/orchestrator/test_locks.py`, 8): global serializes different
  scopes; fine overlaps distinct scopes and serializes the same scope; unkeyed →
  global key; nesting rejected; re-entrant allowed; unknown mode falls back;
  a per-key stress test.
- **Contract suite green in both modes**: `INTERVIEW_OS_LOCK_MODE=fine` and the
  default `global` both pass (exit 0).

## Remaining (the substantive part)

- **Key the facade methods.** Every facade entrypoint currently calls
  `self._hold()` with no keys, so in `fine` mode they all share the `global`
  key — correct but no more concurrent than `global`. Fine-grained benefit needs
  each method to pass the scopes it reads/writes (e.g. `interview:<id>`,
  `target:<id>`, `readiness`, `preparation`, `workspace`), including every
  domain a cross-domain method touches (workspace setup touches
  candidate+target+readiness+preparation; complete-interview touches
  interview+readiness+preparation). This must be done for *all* methods
  together: mixing keyed and unkeyed methods races, because they no longer share
  a lock.
- **Flip the default** to `fine` (and update the docs) once keying is complete
  and the stress test covers cross-domain interleavings.

The default stays `global` for now so a partially-keyed system can never be
selected.
