# AGENTS.md — apps/api (FastAPI backend)

Layer rules for the Python backend. Root `AGENTS.md` holds the mission and the
core invariants; this file is the backend-specific detail.

## Layers (a dependency only ever points downward)
```
api/            FastAPI routers, SSE, error mapping, body limits, static serving
orchestrator/   InterviewOrchestrator facade + domain services (workflow only)
skills/         skill framework, SkillHost, the built-in skills + deterministic mocks
plugins/        in-process plugin host + the SkillHost adapter (inproc)
ai/             AIRuntime, MockRuntime, acp/ (opencode, devin), codex/, claude/, middleware
core/           Pydantic models (single source of state shapes), taxonomy, readiness,
                gaps, prioritize, state machine, serialization, logger, ids, errors
store/          SQLite persistence
```
Rules:
- `core/models` is the **only** place state shapes are defined. Import them; never
  redefine a shape in a service, skill, or router.
- `api/` is thin: parse/validate the body, call one facade method, serialize the
  result through `api/respond.py` (`json_response`) / `api/streaming.py`. No domain logic.
- `orchestrator/` holds workflow, not domain intelligence. Every mutating entrypoint runs
  inside `LockManager.hold(...)` and passes the scopes it reads/writes.
- `ai/` is the only layer that knows a provider. Everything else talks to `AIRuntime`.
- `skills/` never bypasses `SkillHost`; `core/plugin_api.py` is the only plugin contract.

## Invariants you must not break here
- AI output is persisted only after `run_structured` validates it (retry → typed error).
- Readiness stays evidence-backed: snapshots are appended; every score carries its evidence ids.
- All skill calls go through `SkillHost` (`assert_can` before persisting a skill's outputs).
- Plugins are in-process and least-privilege: only declared slices and granted permissions;
  evidence is proposal-only (`evidence.write` is the sole `*.write`, enforced at load).
- Untrusted text (resumes, JDs, answers, documents) never goes into argv or a shell string,
  and is never logged — log lengths, not contents.
- Never log or return secrets/tokens.

## Conventions
- Python 3.13, `from __future__ import annotations`, `ruff` (E,F,I,UP,B,W; line 100),
  `mypy --strict`, Pydantic at every boundary, `__all__`, small modules, no comments
  restating code.
- Child processes use argv arrays (never `shell=True`).
- Add a dependency only after checking the existing stack covers it.

## Commands
```
uv run ruff check . && uv run mypy src tests && uv run pytest
uv run pytest -q
uv run uvicorn interview_os.main:app --port 4100
INTERVIEW_OS_RUNTIME=mock uv run uvicorn interview_os.main:app --port 4100
uv run python -m interview_os.export_schema     # regenerate openapi.json + schema/
```
