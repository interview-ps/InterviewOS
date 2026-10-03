# AGENTS.md — @interview-os/server

Scope: this file governs `apps/server` only. The root `AGENTS.md` holds the repository-wide
invariants and must be followed first; this file adds layer-specific detail and must not
contradict it.

## What this package is
The backend application layer. It owns the Hono HTTP API (`:4100`), the SQLite database
(drizzle + better-sqlite3), the `InterviewOrchestrator` composition root, the skill
implementations, and the provider child processes. It depends on `@interview-os/core`
(schemas/domain) and `@interview-os/runtime` (`AIRuntime`). It is never imported by either.

Public entrypoints (`package.json` exports):
- `.` → `src/index.ts` (process entrypoint: server bootstrap + shutdown)
- `./orchestrator` → `src/orchestrator/index.ts`
- `./skills` → `src/skills/index.ts`

Tests import through `@interview-os/server/orchestrator` and `@interview-os/server/skills`.

## Layout
```
src/index.ts          bootstrap: store, runtime, Plugins, app; SIGINT/SIGTERM shutdown
src/paths.ts          data dirs derived from repo root (workspaces, DB path)
src/http/             Hono API
  app.ts              route mounting + middleware wiring (thin)
  context.ts          typed c.var (orchestrator, runtime, logger, store) + DI middleware
  schemas.ts          request-body Zod schemas
  middleware/         body-limit, error, validate, stream
  routes/<domain>.ts  one router per domain (workspace, targets, readiness, preparation,
                      interviews, loops, resume, history, stories, settings, skills,
                      plugins, runtime, documents, examples)
src/orchestrator/     composition root over services + SQLite
  orchestrator.ts     InterviewOrchestrator: withLock + composition + cross-domain flows
  context.ts          WorkflowContext (store/host/runtime/logger + shared helpers)
  projection.ts       rowToAction / rowToQuestion + view types
  *-service.ts        settings, resume, story, plugin, debrief, history, readiness,
                      preparation, workspace, target, interview, loop
  store/              SQLite data access (index.ts) + drizzle schema + row types
src/skills/           skill implementations
  framework/          skill.ts, runStructured, partialJson, common
  host/               SkillHost, builtins
  analyze/            resume-analyzer, jd-analyzer, gap-analyzer, company-profiler
  prepare/            prep-planner, star-coach, resume-coach
  interview/          interviewer, interview-planner, modes/*
  evaluate/           answer-evaluator, interview-debrief, loop-debrief
  mock/               shared mock helpers
src/adapters/         documents (PDF/DOCX text extraction), examples loader
src/startup/plugin.ts plugin directory loading
test/                 colocated vitest suites (orchestrator, skills, http, plugins, resume)
```

## Layer rules (do not break)
1. **The orchestrator is the only mutator.** HTTP routes must call `InterviewOrchestrator`
   methods; they must not touch `store` or `skill.execute` directly. `store` is reachable
   from routes only for read-only views that lack an orchestrator method.
2. **All skill calls go through `SkillHost`.** Never call `skill.execute` from server or
   orchestrator code. `host.assertCan(id, "<x>.write")` must pass before persisting output.
3. **Services do not import each other's concrete classes** except along the existing DAG:
   `preparation → readiness`, `target → workspace → readiness`, `loop → interview`.
   `interview` receives `loopContextFor` as a lazy callback to avoid a cycle. Cross-domain
   needs are passed as deps interfaces/callbacks, not deep imports.
4. **State shapes live in `@interview-os/core`.** Never redefine an `InterviewOSState`
   slice, score, gap, or evidence shape here.
5. **`withLock` wraps every mutating orchestrator entrypoint.** Public methods delegate to
   services inside `this.withLock(...)`; a service never takes the lock itself.
6. **Runtime-specific logic stays in `@interview-os/runtime`.** The server only holds an
   `AIRuntime` and calls `runTask` / `sendMessage`.
7. **Untrusted input** (resume/JD/answer/document text) never goes into argv or shell
   strings, is never logged (lengths only), and is never exposed to a browser shell.
8. **No secrets in logs or responses.** Provider auth is the provider's own local install.

## HTTP conventions
- One file per domain in `src/http/routes/`; export a `Hono` router; mount in `app.ts`.
- Request bodies are validated with the Zod schemas in `src/http/schemas.ts` via the
  `validate` middleware; parse failures are typed `AppError`s, not 500s.
- Errors go through the centralized `error` middleware (maps `AppError` → status); never
  hand-roll `c.json({ error })` in a route.
- Long/streamed operations use the `stream` middleware and emit progress events.
- The route layer knows only the orchestrator's public surface.

## Database
- `store/index.ts` is mechanical data access (DDL, idempotent `migrate`, CRUD per table);
  it is intentionally a single cohesive unit — do not split it into repositories.
- Snapshots are **appended, never overwritten** (`appendReadinessSnapshot`); scores carry
  their `evidence_ids`.
- The schema is owned by `store/schema.ts`; row types are inferred from it and re-exported.
- Multi-write flows currently commit per statement; if you add a transaction boundary, put
  it in `Store` (a `transaction(fn)` method) and wrap the service flow, do not fake it in
  routes.

## Commands
```
pnpm --filter @interview-os/server typecheck
pnpm typecheck && pnpm test       # from repo root; runs this package's suites too
pnpm dev                          # server :4100 (respects INTERVIEW_OS_RUNTIME)
```

## Testing
- Suites live in `apps/server/test/` (vitest). Keep `tests/integration/feedback-loop.test.ts`
  green — it is the product contract and constructs `new InterviewOrchestrator({ store, runtime, logger })`.
- Prefer driving behavior through the orchestrator public API, not internals.
- Runtime-dependent tests use the mock runtime; provider CLIs are never invoked in unit tests.
- A change is done only after `pnpm typecheck && pnpm test` pass.
