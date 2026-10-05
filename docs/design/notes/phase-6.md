# Phase 6 — HTTP routers, SSE, static serving — DONE

Status: **Done and gated.** `CONTRACT_BACKEND=fastapi uv run pytest` in
`tests/contract` passes with **zero snapshot changes**; the suite also still
passes against Hono (`CONTRACT_BACKEND=hono`). `apps/api` gate green:
`ruff check .`, `mypy --strict src tests`, `pytest`.

## Landed

- **Contract harness**: `tests/contract/harness/server.py` gains `_spawn_fastapi`
  (uvicorn `interview_os.main:app` on the contract temp DB/env, tmpdir registered
  in `SPAWNED_TMPDIRS`). *(User-approved change to a normally read-only area.)*
- **`apps/api/src/interview_os/api/`**: `deps.py` (`AppState` + `StateDep`),
  `errors.py` + `validation.py` (error→status mapping; Pydantic→Zod-exact
  request-validation messages), `respond.py` + `core/serialize.py`
  (Zod omit-undefined serialization), `streaming.py` (SSE), `limits.py`
  (Content-Length and chunked body limits), `static.py`, `schemas.py`.
- **`main.py`**: lifespan builds store + switchable runtime + MCP + orchestrator,
  loads bundled/installed plugins, mounts routers by auto-discovery, disposes on
  shutdown.
- **25 routers** + `adapters/documents.py`, `adapters/examples.py`, and
  `startup/plugins.py` (plugin loader; executor bridge runs the bundled TS
  plugins).
- **`openapi.json`** regenerated.

## Serialization policy (decided)

Zod omits `.optional()` fields (Pydantic: has a default) and keeps `.nullable()`
required fields as explicit `null`. `core/serialize.dump_json` implements this:
drop a key whose value is `None` **iff its field is not required**; a
`json_schema_extra={"emit_null": True}` marker keeps `null` for a few
required-vs-default edge cases (`SkillReadiness.score`, `Gap.currentScore`,
`AnswerEvaluation.star/designUpdates/modeSignals`, `LoopRound.*`,
`SkillDetail.*`, `InterviewDetail.debrief`, `HistoryQuestionNode.*`, …).

## Parity bugs fixed while gating

- `paths.REPO_ROOT` off-by-one (`apps/` → repo root).
- Runtime workspace dirs were cwd-relative (`apps/api/data/...`) → repo-root.
- `preparation.fetch_plugin_resources` injected `skill_id` where Pydantic's
  alias (`skillId: null`) won → id.
- `skills/prepare/mocks.py` trailing-trim regex `r'[.\\s]+$'` (a raw string whose
  class included `s`) stripped trailing `s` ("Payments"→"Payment").
- Star-coach mock lower-cased the role in feedback.
- `plugin.py` enum-setting error joined a Python list (`['a', 'b']`) instead of
  `", ".join`.
- `question_bank` import message, export-bundle message, and the interview-pack
  YAML export (custom PyYAML dumper matching the JS `yaml` stringifier).
