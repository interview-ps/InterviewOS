# Phase 8 — cut-over

Status: **in progress**. The contract suite's default backend is now FastAPI
(`tests/contract/harness/server.py`); `uv run pytest` in `tests/contract` is green
with no `CONTRACT_BACKEND` set (exit 0).

## Done

- **Test gate flipped**: `CONTRACT_BACKEND` defaults to `fastapi`; "hono" is the
  legacy reference backend, retired here. Full contract suite green on the
  default (zero snapshot changes), and `apps/api` ruff + mypy --strict + pytest
  green.

## Remaining (destructive / shared — needs sign-off)

The design's phase 8 also says: `pnpm dev`/`start` run FastAPI; **delete
`apps/server`, `packages/runtime`, and the hand-written `packages/core`**; and
rewrite the docs (§15). Those are gated because:

1. `apps/server`, `packages/`, and `apps/web` are the read-only reference areas
   and currently hold **unrelated uncommitted work** from a parallel TS effort;
   deleting them discards that work.
2. `apps/web` imports `@interview-os/core` (e.g. `type UINode`). Removing the
   hand-written `packages/core` requires the generated Python→TS types/client to
   replace it first (design §13.1 "schema export + TS codegen"), which is not yet
   wired.
3. Root `package.json` `dev`/`start` currently drive the TS server + Vite; moving
   them to uvicorn changes the shared dev workflow the parallel effort uses.

Proposed order once approved: (a) wire codegen so `apps/web` builds without
`packages/core`; (b) point `dev`/`start` at uvicorn + the built SPA; (c) delete
the retired trees in a dedicated commit; (d) rewrite the docs (§15).

## Note

Hono's plugin tests are red from phase 7 (its loader reads the removed
`skill.yaml`). With FastAPI now the default, they no longer run by default; the
Hono backend is removed in step (c).
