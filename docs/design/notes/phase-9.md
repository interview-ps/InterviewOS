# Phase 9 — fine-grained locks

Status: **done.** The default lock mode is `fine`.

## What landed

- **`LockManager` supports `global` and `fine`** (design §8.1):
  - `fine` (default): one `asyncio.Lock` per scope key, acquired in a **total
    order** (sorted keys) so concurrent acquisitions cannot deadlock; an unkeyed
    call maps to the `global` key; an unknown `INTERVIEW_OS_LOCK_MODE` falls back
    to `global`.
  - `global` remains available via `INTERVIEW_OS_LOCK_MODE=global` as the parity
    fallback.
  - **No-nesting guard**: a nested `hold()` with new keys raises; re-entering
    only already-held keys is allowed (contextvar-tracked).
- **Every facade method passes the scopes it touches.** No `_hold()` call is
  unkeyed. Domains: `candidate`, `target`, `readiness`, `preparation`,
  `interview`, `loop`, `stories`, `resume`, `settings`, `packs`, `plugins`,
  `mcp`. A method takes every domain it reads/writes — e.g. `setup_workspace`
  takes candidate+target+readiness+preparation; `complete_interview` takes
  interview+loop+readiness+preparation+target+candidate; `import_state` takes
  **all** domains (it rewrites everything, so it must exclude every keyed
  method).
- **Tests** (`tests/orchestrator/test_locks.py`, 8): global serializes different
  scopes; fine overlaps distinct scopes and serializes the same scope; unkeyed →
  global; nesting rejected; re-entrant allowed; unknown mode falls back; a per-key
  stress test.

## Verification

- **Contract suite green in BOTH modes**: default `fine` and
  `INTERVIEW_OS_LOCK_MODE=global` (exit 0 each).
- `apps/api`: ruff + `mypy --strict` (246 files) + pytest green under the default
  `fine`.

## Notes

- Read-only facade methods (`list_*`, `get_*`) never held a lock, in either mode;
  that is unchanged.
- `readiness` is the hot key (many mutating methods include it, since it is read
  or recomputed widely). That is a conservative, race-free choice; further
  concurrency would need short readiness scopes + recompute coalescing (design
  §8.1), which is left as a future optimisation, not a correctness gap.
