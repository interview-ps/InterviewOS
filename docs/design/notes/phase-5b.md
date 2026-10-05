# Phase 5b — orchestrator services, facade, feedback loop

Status: **Done**. Exit gate green: `uv run pytest` (823 passed, 4 skipped),
`uv run ruff check .`, `uv run mypy src tests`.

## Delivered

- **Eight services** under `apps/api/src/interview_os/orchestrator/services/`:
  `readiness.py`, `preparation.py`, `workspace.py`, `target.py`, `interview.py`,
  `loop.py`, `debrief.py`, `plugin.py` (ported 1:1 from the TS sources).
- **Plugin executor**: `apps/api/src/interview_os/plugins/executor.py`, with
  `runner/runner.mjs` + `runner/sdk-shim.mjs` copied verbatim and a new trusted
  `runner/bridge.mjs`.
- **Store additions**: `runtime_sessions` CRUD (`insert_runtime_session`,
  `get_runtime_session`, `update_runtime_session_status`), `reset_all`, and the
  `plugin_installs`/`plugin_settings`/`plugin_storage` CRUD + row models.
- **Facade**: `orchestrator/orchestrator.py` — the full Contract-A public
  surface in snake_case, `LockManager` (global mode), and the serialized
  fire-and-forget plugin-event queue.
- **Tests**: `tests/integration/test_feedback_loop.py` (both TS cases) green on
  the MockRuntime; `tests/integration/conftest.py` adds the `app` fixture.

## Design decisions

- **Locking**: phase 5b implements only `LockManager(mode="global")` (one
  `asyncio.Lock` for every scope) — the parity mode through phases 5–8.
  `INTERVIEW_OS_LOCK_MODE` + the `hold(*keys)` seam are in place so phase 9
  replaces the body without touching the facade.
- **Plugin executor IPC**: `runner.mjs` speaks only Node IPC (`process.send`),
  which a Python parent cannot drive. Per the plugin plan (verbatim runner,
  preserved `node --permission` sandbox), `executor.py` spawns `bridge.mjs`,
  which `fork`s the verbatim runner with the same `--allow-fs-read` flags and
  relays newline-delimited JSON on stdio. The bridge is host code deleted in
  phase 7.
- **Deferred**: the `loop.test.ts` / `modes.test.ts` ports depend on
  `loadPlugins(...)` and the plugin-provided modes (`technical`,
  `system_design`, `behavioral`, …). Every non-`mixed` mode is plugin-provided,
  so these move to phase 7 with the plugin system. `mixed` flows are covered by
  the feedback-loop port.

## Adversarial review (TS↔Python diff) — resolved

Fixed in this phase:

- `complete_action` now reads camelCase `checkedCriteria` (HTTP contract) as
  well as the snake_case alias — was silently ignored (`preparation.py`).
- `validate_answer_fields` rejects non-finite numbers (`inf`/`NaN`), matching
  TS `Number.isFinite` (`interview.py`).
- Facade `sync_plugin_packs` no longer takes the lock (parity with TS; avoids a
  non-reentrant deadlock path) (`orchestrator.py`).

## Phase-6 blockers (recorded, NOT yet fixed)

These are serialization-shape differences that will diverge from the recorded
contract snapshots. They are phase-6 (HTTP) work, not phase-5b logic:

1. **Optional-vs-null JSON**: Pydantic emits `"x": null` for unset optionals
   where Zod/`JSON.stringify` omits the key. Affected: `Requirement.boostedBy`
   and `origin`, `TargetRole.companyProfile`/`companyNotes`/`rolePackId`,
   and `SubmitAnswerResult.pluginReviews`. Note `voiceFeedback: null` and
   `completedAt: null` **must stay**. Fix must be per-field (track field-set and
   serialize with `exclude_unset`, or omit the kwarg when unset), never a global
   `exclude_none`.
2. **Executor end-to-end**: the `bridge.mjs` path has not been exercised against
   a real plugin yet. The contract suite runs `interview-day-checklist` and the
   `postgres-interviewer` UI frame, so phase 6 must first prove the bridge with
   a bundled plugin before wiring the plugin routes.

Low-risk notes accepted as-is: `_packs()` guard error code, `candidate.name or`
vs `??` on empty strings, executor child env also passing `PATH`, and
`runTaskResult` payload reshaping.
