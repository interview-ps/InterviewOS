# AGENTS.md — Interview OS

## Mission
Interview OS is an open-source, local-first interview-preparation OS. It builds and continuously
updates an **evidence-backed model of a candidate's interview readiness**, then uses it to plan
preparation and to run interviews that deliberately retest weak areas. It is not a random
interview-question generator. See `ARCHITECTURE.md` for the full design.

## Core invariants (do not break)
1. **No skill may create its own independent candidate model.** All state shapes live in
   `packages/core` (Zod). Import them; never redefine them.
2. **AI-generated state mutations must pass schema validation** (`runStructured` in
   `packages/skills`) before anything is persisted. Malformed output → retry → typed error.
3. **The readiness graph must remain evidence-backed.** Scores are derived from `skill_evidence`
   by `core/readiness`; snapshots are appended, never overwritten; every exposed score carries
   its evidence ids.
4. **Runtime-specific logic stays behind `AIRuntime`.** Only `packages/runtime` knows about Codex.
5. The orchestrator contains workflow, not domain intelligence. Skills are small and single-purpose.
6. Resumes, JDs, answers, company notes and uploaded documents are untrusted: never put them
   in process argv or shell strings, never log their contents (lengths only), never expose a
   shell to the browser.
7. Never log or return secrets/tokens. Codex auth is handled by the local Codex install.
8. **All skill calls go through `SkillHost`.** Never call `skill.execute` from orchestrator or
   server code. Manifests declare inputs/permissions; the host rejects undeclared input keys,
   gates `ctx.runtime` behind `runtime.invoke`, and `host.assertCan(id, "<x>.write")` must pass
   before persisting a skill's outputs. Plugins are read-only local code: manifests requesting
   `*.write` are rejected at load, and a plugin only ever receives the state slices it declares —
   it cannot mutate application state.

## Repository map
```
apps/server         Hono API :4100, owns SQLite + Codex child process
apps/web            Next.js + Tailwind UI :3000 (/api → server)
packages/shared     logger (redacting), ids, errors
packages/core       schemas, taxonomy, readiness, gaps, prioritize, state machine
packages/runtime    AIRuntime, MockRuntime, codex/ (exec adapter + app-server)
packages/skills     resume-analyzer, jd-analyzer, gap-analyzer, company-profiler,
                    prep-planner, star-coach, resume-coach, interviewer,
                    answer-evaluator, interview-debrief, loop-debrief, host/SkillHost
packages/orchestrator InterviewOrchestrator + SQLite store (drizzle/better-sqlite3)
examples/           seed resumes + JDs (backend-engineer is canonical)
plugins/            local read-only plugins (INTERVIEW_OS_PLUGINS_DIR overrides)
tests/              integration (canonical feedback loop), fixtures/fake-codex.mjs, e2e
```

## How things work
- **Shared state**: `InterviewOSState` is assembled by the store from SQLite. Skills get typed
  slices as input and return typed outputs; the orchestrator applies them as mutations.
- **Skills**: `InterviewSkill<I,O>{ id, inputSchema, outputSchema, execute(input, ctx) }`.
  AI skills call `runStructured` → `ctx.runtime.runTask` (or `sendMessage` for the interviewer's
  session thread). Prompts live in each skill's `prompt.ts`.
- **Codex runtime**: one-shot tasks use `codex exec --json --output-schema … -` (prompt on stdin,
  read-only sandbox, cwd `data/codex-workspace`). Interview sessions use a backend-owned
  `codex app-server` (JSON-RPC over stdio); Interview OS session ↔ Codex thread id is persisted
  in `runtime_sessions` and resumed with `thread/resume`.
- **MockRuntime**: deterministic; `INTERVIEW_OS_RUNTIME=mock`. Must support the whole flow.

## Commands
```
pnpm install
pnpm dev                          # server :4100 + web :3000 (Codex runtime)
INTERVIEW_OS_RUNTIME=mock pnpm dev
pnpm typecheck && pnpm test       # unit + runtime + integration (mock, fake codex)
pnpm test:e2e                     # Playwright on mock runtime
INTERVIEW_OS_LIVE_CODEX=1 pnpm test:codex   # opt-in, uses real local Codex
```

## Testing requirements
- Unit tests for state transitions, gaps, readiness/evidence aggregation, prioritisation, schemas.
- Runtime tests use `tests/fixtures/fake-codex.mjs` (no tokens). Live Codex tests are opt-in.
- `tests/integration/feedback-loop.test.ts` is the product: it must always pass.
- A feature is not done because it compiles; run the tests.

## Conventions
TypeScript strict, ESM, Zod for every boundary, small modules, no comments restating code,
argv arrays for child processes, no new dependency without checking the existing stack covers it.

## Not yet (v0.2+)
Cover letters, LinkedIn optimisation, job-search automation, offer comparison, salary
negotiation, company-profile libraries, large question banks, PDF parsing, multi-user/collab.
