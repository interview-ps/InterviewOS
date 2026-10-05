# Interview OS API (Python)

FastAPI backend for Interview OS — the port target of `apps/server`
(design: `docs/design/fastapi-backend-refactor.md`). **Status: phase 3** —
core Pydantic models, the SQLAlchemy store over the existing SQLite file, the
Alembic baseline, a health endpoint, and the AI runtime layer (`ai/`: Mock,
Codex exec + app-server, Claude Agent SDK, opencode, Devin, `run_structured`).
Skills, orchestrator, routers, plugins and packs land in phases 4–7.

```
uv sync                                  # create .venv from uv.lock
uv run pytest                            # unit + store + DDL parity + runtime tests
uv run pytest tests/ai                   # runtime suites only
uv run ruff check . && uv run mypy src   # lint + types
uv run python -m interview_os.export_schema   # openapi.json + schema/*.json
uv run uvicorn interview_os.main:app --port 4100
uv run alembic -c src/interview_os/store/migrations/alembic.ini upgrade head
INTERVIEW_OS_LIVE_CODEX=1 uv run pytest tests/ai/test_live.py   # opt-in, real CLI
```

The store opens `data/interview-os.db` (override with `INTERVIEW_OS_DB`);
`alembic upgrade head` creates a fresh database and stamps the baseline when
the tables already exist, so existing databases are never recreated.

`export_schema.py` writes `openapi.json` (FastAPI) and `schema/<group>.json`
(Pydantic `model_json_schema()` per core model group). There is no TypeScript
generator yet: the web client is only migrated at cut-over (phase 6/8), so a
generated client would have nothing to consume it.

## AI layer (`src/interview_os/ai`)

Port of `packages/runtime` plus `runStructured`/`partialJson`. `AIRuntime` is
the only provider surface the rest of the backend sees (invariant #4);
`RuntimeManager` makes the active provider switchable at runtime.

- Provider selection: `INTERVIEW_OS_RUNTIME` env > saved `runtimeKind` >
  `codex`, with `INTERVIEW_OS_RUNTIME_FALLBACK=mock` as the only fallback.
- Workspaces: `data/<kind>-workspace`, overridable with
  `INTERVIEW_OS_<KIND>_WORKSPACE`.
- Custom providers come only from local `interview-os.runtimes.json`; each
  entry names a Python module exporting a `RuntimeProviderSpec` as `PROVIDER`.
- Untrusted prompts travel on stdin (codex exec/app-server, opencode) or in a
  workspace temp file (Devin), never in argv; child environments are
  allowlists (`codex/claude/opencode/devin/child_env.py`).
- Tests run against `tests/fixtures/fake-codex.mjs` (shared with the
  TypeScript suite) and `tests/fixtures/fake_provider_cli.mjs`; live provider
  smoke tests are opt-in via `INTERVIEW_OS_LIVE_*`.
