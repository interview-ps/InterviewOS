# Phase 8 — cut-over

Status: **code cut-over done**; the §15 documentation rewrite remains (the
doc files are entangled with unrelated in-progress work in this worktree).

## Done

- **Test gate**: contract suite defaults to FastAPI (`tests/contract` green with
  no `CONTRACT_BACKEND`; commit `75cbe6b`).
- **Frontend types**: `@interview-os/frontend-types` holds generated model types
  (`apps/api/scripts/generate_ts_types.py`) + the relocated UI vocabulary,
  taxonomy and voice constant. `packages/ui` and `apps/web` are repointed; all
  three typecheck clean under the strict tsconfig (`4a400f6`, `f2d6afe`,
  `0253f8d`, `690efd7`).
- **Deletion** (`2ec94b2`): `apps/server`, `packages/runtime`, `packages/core`
  and `packages/plugin-sdk` are gone (the SDK depended on the deleted runtime +
  core, and all plugins are Python now), along with the TS suites that imported
  them (`tests/integration`, the TS-only parts of `tests/golden`,
  `tests/fixtures/runtime-provider`).
- **Scripts**: root `package.json` runs the Python backend — `dev`/`build` build
  the SPA, `dev:api` runs uvicorn, `start` builds then serves UI+API from
  FastAPI, `test` → apps/api pytest, `test:contract` → the Python contract
  suite. `tests/e2e/serve.mjs` (Playwright webServer) spawns uvicorn.
- **Golden fixtures restored** (`2fc3547`): `tests/golden/*.json` are the Python
  parity oracle (`apps/api/tests/test_golden.py`); only the TS-only parts stay
  deleted.

Surviving workspace: `apps/api` (FastAPI), `apps/web`, `packages/ui`,
`packages/frontend-types`. Gate: `apps/api` ruff + mypy --strict + pytest green;
contract suite green on FastAPI; `tsc` clean for frontend-types/ui/web.

## Remaining

- **§15 documentation**: root `AGENTS.md` + new `apps/api/AGENTS.md` rewritten;
  `ARCHITECTURE.md` and `docs/plugins.md` updated to Python (paths, plugin
  layout/host, authoring, isolation, bundling). `CONTRIBUTING.md` still needs its
  Python pass, and a few illustrative TS snippets remain in `ARCHITECTURE.md` /
  `docs/plugins.md` (interface/code samples).
- `pnpm test:e2e` against FastAPI (Playwright) — the launcher is rewired; the
  suite itself is unaffected.
