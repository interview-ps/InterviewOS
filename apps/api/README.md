# Interview OS API (Python)

FastAPI backend for Interview OS — the port target of `apps/server`
(design: `docs/design/fastapi-backend-refactor.md`). **Status: phase 1a** —
core Pydantic models, the SQLAlchemy store over the existing SQLite file, the
Alembic baseline, and a health endpoint. Skills, orchestrator, AI runtimes,
routers, plugins and packs land in phases 3–7.

```
uv sync                                  # create .venv from uv.lock
uv run pytest                            # unit + store + DDL parity tests
uv run ruff check . && uv run mypy src   # lint + types
uv run python -m interview_os.export_schema   # openapi.json + schema/*.json
uv run uvicorn interview_os.main:app --port 4100
uv run alembic -c src/interview_os/store/migrations/alembic.ini upgrade head
```

The store opens `data/interview-os.db` (override with `INTERVIEW_OS_DB`);
`alembic upgrade head` creates a fresh database and stamps the baseline when
the tables already exist, so existing databases are never recreated.

`export_schema.py` writes `openapi.json` (FastAPI) and `schema/<group>.json`
(Pydantic `model_json_schema()` per core model group). There is no TypeScript
generator yet: the web client is only migrated at cut-over (phase 6/8), so a
generated client would have nothing to consume it.
