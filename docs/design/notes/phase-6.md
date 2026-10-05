# Phase 6 — HTTP routers, SSE, static serving (IN PROGRESS)

Status: **foundation landed, not gated**. The full contract suite against FastAPI
does not pass yet; see Blockers. `apps/api` gate remains green (lint, mypy,
pytest) and `test_examples` passes against FastAPI via the contract harness.

## Landed

- **Contract harness**: `tests/contract/harness/server.py` gains `_spawn_fastapi`
  (uvicorn `interview_os.main:app` on the contract temp DB/env, tmpdir registered
  in `SPAWNED_TMPDIRS`). `CONTRACT_BACKEND=fastapi` now boots the Python backend.
  *(User-approved change to a normally read-only area.)*
- **`apps/api/src/interview_os/api/`**: `deps.py` (`AppState` + `StateDep`),
  `errors.py` (error→status mapping incl. structured-runtime classes;
  `RequestValidationError` → 400 VALIDATION), `streaming.py` (`stream_or_json`,
  SSE `stage`/`delta`/`result`/`error` + 10 s ping, work runs in a task that
  outlives the client), `limits.py` (pure-ASGI 200KB/25MB/5MB body limits),
  `static.py` (SPA fallback), `schemas.py`.
- **`main.py`**: lifespan builds store, switchable runtime, MCP manager and the
  orchestrator; mounts routers; disposes on shutdown.
- **Routers**: `workspace` (setup, analysis, state, test/reset), `runtime`,
  `companies`, `examples`, `skills`, `modes`, `settings`.
- **Adapter**: `adapters/examples.py`.
- **Bugs fixed**: `paths.REPO_ROOT` was off by one (`parents[3]`→`parents[4]`,
  it pointed at `apps/` so every repo path was wrong); the examples adapter now
  reads files verbatim so CRLF is preserved.

## Verified

- `CONTRACT_BACKEND=fastapi uv run pytest test_examples.py` → 3 passed
  (boots under the harness, serves, resets, snapshots match).
- `apps/api`: `ruff` clean, `mypy --strict` clean, `pytest` green (phase 5b intact).

## Blockers (must be decided before mass router porting)

1. **null-vs-omitted JSON (systemic).** Zod omits `undefined` optional fields;
   Pydantic emits `"x": null`. Confirmed on `/api/skills` (every optional
   manifest field appears as `null`). Affects targets/requirements, plugin
   views, interview results, etc. `exclude_none` is not a global fix because
   some fields legitimately stay `null` (`voiceFeedback`, `completedAt`, …).
   Needs a decided strategy — e.g. mark optional-omit fields and serialize with
   `exclude_unset` (services stop passing `None` for them), or a per-model
   serializer.
2. **Zod-exact validation messages.** 26 fixtures encode Zod strings
   (`invalid request body: enabled: Invalid input: expected boolean, received
   undefined`). Pydantic messages differ. Needs a Zod-compatible
   validation-error formatter, or an accepted divergence.
3. **Plugin loader not ported.** `startup/plugins.ts` (`loadPlugins`, manifest
   validation, executor wiring) has no Python equivalent yet; required for the
   plugin routes, `skills[].compatible`, and `/api/modes`.

## Decisions (approved)

1. **null-vs-omitted → marker-based omit.** Implement an "omit when None" marker
   on optional fields and a single serialization helper used everywhere JSON is
   produced (store `_dump`, `tool` responses, FastAPI responses). Fields that are
   genuinely `.nullable()` keep emitting `null`; fields that are `.optional()`
   are omitted when unset. Plan:
   - add `json_schema_extra={"omit_none": True}` (or a small `Omit` marker) to
     every field whose Zod source is `.optional()` (not `.nullable()`), auditing
     `packages/core/src/**` model-by-model;
   - central `dump(model, *, mode)` that calls `model_dump(by_alias=True,
     mode="json")` then drops keys flagged `omit_none` whose value is `None`;
   - route/store/executor call sites switch to it; FastAPI needs a custom
     `jsonable_encoder`/`JSONResponse` path (and `response_model` overrides) so
     nested models honour the marker.
2. **Zod-exact validation messages.** Write a Pydantic→Zod-style formatter that
   reproduces `invalid request body: <path>: <Zod message>` for the 26 fixtures
   (map Pydantic `missing`/`bool_type`/`string_type`/`too_short`/… to Zod v3
   strings using the field annotation). Wire it into the
   `RequestValidationError` handler.

## Remaining routers

interviews, loops, resume, history, stories, readiness, preparation, targets,
packs, interview-packs, question-bank, plugins, platform, ui, mcp, export,
documents, usage, `events`/`metrics`/`/api/state`.
