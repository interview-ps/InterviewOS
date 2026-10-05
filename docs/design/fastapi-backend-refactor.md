# Design: FastAPI Backend Refactor

Status: **Accepted — implementation started** (see migration status below).
Scope: replace the TypeScript backend (`apps/server`, `packages/runtime`, and the
server-side use of `packages/core`) with a Python FastAPI backend. The React UI
(`apps/web`) stays.

## Migration status

| Phase | State |
|---|---|
| 0. Contract suite + golden fixtures | **Done** (`30d9ffc`). `tests/contract/` 104 tests, 91/91 routes, snapshots byte-identical across runs. `tests/golden/` 428 cases, synced by vitest. |
| 1. `apps/api` scaffold: core models, store, Alembic baseline, schema export | **Done** (`0f7a846`). 87 tests incl. DDL parity (zero diffs) against a server-generated DB; store opens a copy of the real DB. |
| 2. Port `core` logic (reproduce golden fixtures) | **Done** (`6571845`). 428/428 golden cases green; 557 tests total; `js_compat` for JS number/date parity. |
| 3. Port `ai/` runtimes + `run_structured` | **Done** (`b4bb74c`). 729 tests (4 live opt-in skipped); codex suite drives the real `fake-codex.mjs`; claude seam with lazy Python SDK import. |
| 4. Port skills + `SkillHost` | **Done** (`ebb6205`, `4310afc`, `a6aa373`, `cd1f735`). Framework, `SkillHost`, all 12 built-in skills + deterministic mocks, builtins registry; 744 tests. |
| 5. Port orchestrator services | **Done** (`9b8cdab` foundation, `a5e7790` 5a, this commit 5b). `PackRegistry`, `McpManager`, the 15 services, the plugin executor, and the `InterviewOrchestrator` facade. Exit gate green: 823 tests (4 skipped), `ruff` + `mypy --strict` clean, feedback-loop pytest green. Phase-6 blockers logged in [`notes/phase-5b.md`](./notes/phase-5b.md). |
| 6. Port HTTP routers + streaming + static serving | **Done**. 25 routers, SSE `stream_or_json` (stage/delta/result/error + 10 s ping, disconnect never aborts), body limits (400/413 parity), static serving, lifespan. Contract suite green against FastAPI with **zero snapshot changes** (and still green on Hono). Zod-exact request-validation messages (`api/validation.py`) and Zod omit-undefined serialization (`core/serialize.py`). |
| 7. Plugin system (Octop model) + port 9 bundled plugins | **In progress**. In-process host landed (`plugins/{manifest,context,registry,loader,tools,manager,seed,dispatch,bootstrap}.py` + `ai/middleware.py`; 185 tests) and all 9 bundled plugins ported to Python (`plugin.yaml` + `main.py`, TS `skill.yaml`/`index.ts` removed). The migrated `PluginService`/`SkillHost` is backed by `plugins/inproc.py` (`PythonPluginExecutor`), so every plugin route works unchanged: FastAPI contract suite (incl. `test_plugins`/`test_installs`/`test_meta`) green with **zero snapshot changes**. Hono's plugin tests are red until the phase-8 cut-over (its loader still reads `skill.yaml`, now removed by design). Remaining: the web plugin screens. |
| 8. Cut-over | **Code done** (`75cbe6b` default FastAPI backend, `4a400f6` web/ui repoint, `2ec94b2` deleted `apps/server`+`packages/{runtime,core,plugin-sdk}`+TS suites, `2fc3547` golden restore). FastAPI is the default; frontend uses `@interview-os/frontend-types`; root scripts run uvicorn. Remaining: the §15 doc rewrite (deferred — those files carry unrelated in-progress changes). See [`notes/phase-8.md`](./notes/phase-8.md). |
| 9. Fine-grained locks default | **In progress**. `LockManager` supports `global` and `fine` (total-order keyed locks, no-nesting guard, unkeyed→global; 8 tests, contract suite green in both modes). Remaining: key every facade method consistently, then flip the default. See [`notes/phase-9.md`](./notes/phase-9.md). |

Companion design: **[Python Plugin System (Octop model)](./python-plugin-system.md)**.
The plugin system is specified there and only referenced here (§12).

Motivation: team skill (Python) and room for Python-native AI work (embeddings,
local models, speech, evals) behind the runtime layer.

---

## 1. Current backend (baseline)

| Area | Today | Size |
|---|---|---|
| HTTP | Hono on `:4100`, 25 domain routers in `apps/server/src/http/routes/`, Zod request schemas, `error` / `validate` / `body-limit` / `stream` middleware | 91 routes |
| Orchestrator | `InterviewOrchestrator` facade + 15 services (`settings, workspace, target, readiness, preparation, interview, loop, debrief, history, story, resume, plugin, pack, mcp, export`), one global `withLock` promise queue | ~8.5k LOC |
| Store | drizzle over `node:sqlite`, one cohesive `store/index.ts`, schema in `store/schema.ts` | 22 tables |
| Skills | `runStructured` framework, `SkillHost`, 12 built-in skills (analyze / prepare / interview / evaluate), mode skills | ~3k LOC |
| Core | Zod schemas, taxonomy, readiness, gaps, prioritise, state machine, redacting logger, `PLUGIN_HOOKS` | ~6k LOC |
| Runtime | `AIRuntime`, `RuntimeManager`, Codex (exec + app-server JSON-RPC), Claude Agent SDK, opencode, Devin, Mock | ~4k LOC |
| Other | plugin executor (Node child process), `PackRegistry`, `McpManager`, document extraction (unpdf, mammoth) | ~1.9k LOC |
| Tests | vitest units, `tests/integration/feedback-loop.test.ts`, `fake-codex.mjs`, Playwright e2e | ~4k LOC |

Tables: `candidate_profiles, target_roles, interview_sessions, interview_loops,
interview_questions, candidate_answers, answer_evaluations, skill_nodes,
skill_evidence, plugin_installs, readiness_scores, preparation_actions,
runtime_sessions, interview_debriefs, star_stories, settings, resume_reviews,
interview_packs, user_questions, mcp_servers, external_contexts, usage_events`.

## 2. Goals and non-goals

Goals
- **Same HTTP contract** (paths, bodies, status codes, SSE events). The web UI
  changes only for plugin screens (§12).
- **Same SQLite file**, readable by the new backend with no data loss.
- Keep every root `AGENTS.md` invariant except those the plugin design
  explicitly replaces (§12 and plugin design §12).
- A Python-native AI layer that's easy to extend.

Non-goals
- Postgres, multi-user support, microservices, auth.
- Redesigning the domain (readiness math, gap logic, prompts are ported 1:1).
- Rewriting the frontend.

## 3. Target stack

| Concern | Choice | Replaces |
|---|---|---|
| Language / tooling | Python 3.12, `uv` workspace, `ruff`, `mypy --strict` | TS strict, pnpm, tsc |
| HTTP | FastAPI + Uvicorn | Hono + `@hono/node-server` |
| Validation / schemas | Pydantic v2 | Zod |
| DB | SQLAlchemy 2 (Core + typed tables) on SQLite (`aiosqlite`), Alembic | drizzle + `node:sqlite` |
| SSE | `sse-starlette` `EventSourceResponse` | `hono/streaming` |
| Claude | `claude-agent-sdk` (Python) | `@anthropic-ai/claude-agent-sdk` |
| MCP | `mcp` (Python SDK) | `@modelcontextprotocol/sdk` |
| Documents | `pypdf`, `mammoth` (Python) | `unpdf`, `mammoth` |
| YAML | PyYAML (`safe_load` only) | `yaml` |
| Tests | `pytest`, `pytest-asyncio`, `httpx.AsyncClient` | vitest |
| E2E | Playwright (unchanged, TS) | — |

Every dependency is pinned to a version published at least 7 days earlier.

## 4. Target layout

```
apps/api/                         Python backend (uv project)
  pyproject.toml
  src/interview_os/
    main.py                       app factory, lifespan (store, runtime, plugins), shutdown
    paths.py                      repo/data paths (DB, plugins, packs, workspaces)
    core/                         ← packages/core (pure, no I/O)
      models/                     Pydantic: candidate, target, interview, assessment,
                                  readiness, preparation, resume, packs, platform, state
      taxonomy.py  readiness.py  gaps.py  prioritize.py  state_machine.py
      ids.py  errors.py  logger.py (redacting, lengths only)
      plugin_api.py               PLUGIN_HOOKS request/response models
    ai/                           ← packages/runtime
      runtime.py                  AIRuntime Protocol, ProgressUpdate
      manager.py                  RuntimeManager (probe, hot-swap)
      structured.py               run_structured (validate → retry → typed error)
      process.py                  subprocess helpers (argv arrays, stdin/tempfile I/O)
      codex/ claude/ opencode/ devin/ mock/
      providers.py                interview-os.runtimes.json loader
    skills/                       ← apps/server/src/skills
      framework.py  host.py (SkillHost)  builtins.py
      analyze/ prepare/ interview/ evaluate/ mock/
    orchestrator/                 ← apps/server/src/orchestrator
      orchestrator.py             InterviewOrchestrator facade + lock
      context.py                  WorkflowContext
      projection.py
      services/                   one module per service (same 15)
    store/                        ← store/index.ts + schema.ts
      schema.py                   22 tables, same names/columns
      store.py                    Store (CRUD, append_readiness_snapshot, transaction)
      migrations/                 Alembic (baseline = current DDL)
    api/                          ← apps/server/src/http
      deps.py                     DI: orchestrator, runtime, store, logger
      errors.py                   AppError → status mapping
      streaming.py                stream_or_json (SSE contract §10.3)
      limits.py                   body-limit middleware
      static.py                   SPA serving for `start`
      routes/<domain>.py          25 routers (§10.1)
    plugins/                      see python-plugin-system.md
    packs/registry.py             ← PackRegistry
    mcp/manager.py                ← McpManager
    adapters/                     documents.py, examples.py, git.py
  tests/                          pytest (unit, orchestrator, http, plugins)
apps/web/                         unchanged (+ generated API client)
packages/core/                    becomes generated TS types only (§5)
packages/runtime/, apps/server/   deleted at cut-over (§14)
tests/contract/                   black-box HTTP suite run against either backend
```

## 5. Single source of truth for schemas

- `interview_os.core.models` (Pydantic) is the **only** place state shapes are
  defined (invariant #1 holds, with its location moved to Python).
- The build exports `openapi.json` and JSON Schemas:
  - `apps/web` uses a generated client and types (`openapi-typescript`).
  - `packages/core` is reduced to generated TS types plus the shared constants
    the UI needs (taxonomy labels, hook names). No hand-written Zod is left.
- CI check: regenerate, then `git diff --exit-code`. Stale generated code fails
  the build.

## 6. Layer rules (carried over from `apps/server/AGENTS.md`)

1. The orchestrator is the only mutator. Routes call orchestrator methods only.
2. All skill calls go through `SkillHost`. `host.assert_can(id, "<x>.write")`
   runs before any persist.
3. Service DAG is unchanged: `preparation → readiness`,
   `target → workspace → readiness`, `loop → interview`. `interview` gets
   `loop_context_for` as a callback. Cross-domain needs are passed as
   `Protocol` deps, not imports.
4. State shapes live in `core`, never redefined in services or skills.
5. Every mutating orchestrator entrypoint is wrapped in `self._locked(...)`.
   Services never take the lock.
6. Provider logic stays in `ai/`.
7. Untrusted text never goes into argv or shell strings, and is never logged
   (only lengths).
8. No secrets in logs or responses.

## 7. Store

- `schema.py` declares the 22 tables with **identical table and column names
  and types**. The new backend opens the existing `data/*.db` unchanged.
- Alembic baseline revision = today's DDL. The idempotent `migrate()` is
  replaced by `alembic upgrade head` at startup. The baseline is stamped
  automatically when the tables already exist.
- `Store` stays one cohesive class, mirroring `store/index.ts` (no repository
  split). It adds `async with store.transaction():` for multi-write flows.
- `append_readiness_snapshot` is append-only, and every score row carries its
  `evidence_ids` (invariant #3).
- JSON columns are typed by the Pydantic models in `core` and validated on
  read and write.

## 8. Orchestrator

- `InterviewOrchestrator(store, runtime, logger, plugins, packs, mcp)` keeps
  the **same public method names**, in snake_case. It is the surface the routes
  and the ported feedback-loop test depend on.
- Concurrency: **fine-grained aggregate locks** (decision D3, §8.1). During
  porting the same API runs in `global` mode for parity.
- Fire-and-forget plugin events (`events.*`) stay a **serialized queue**, as
  today. Hooks run outside any lock scope, and their evidence proposals are
  persisted in a `readiness` scope.

### 8.1 Locking (decision D3: fine-grained)

**Why it's needed.** Today one promise queue wraps 47 entrypoints, *including
their AI calls* (e.g. `analyzeCandidate`, `startInterview`, `submitAnswer`,
`completeInterview` → debrief + loop advance). A minute-long resume analysis
blocks every other mutation. There is no workspace concept (no
`workspace_id`), so the units of locking are domain aggregates.

**Lock keys and ranks** (lower rank is always acquired first):

| Rank | Key | Guards |
|---|---|---|
| 0 | `exclusive` (RW lock) | every scope takes it **shared**; `reset_all`, `import_state` take it **exclusive** |
| 1 | `settings` | settings, runtime selection |
| 2 | `registry` | plugins config, packs, interview packs, question bank, MCP servers/contexts, skill nodes |
| 3 | `candidate` | candidate profile, resume reviews, STAR stories |
| 4 | `targets` | target set + active-target pointer (create / activate) |
| 5 | `target:<id>` | one target's data (company profile, role pack) |
| 6 | `loop:<id>` | one interview loop |
| 7 | `session:<id>` | one interview session: questions, answers, evaluations, debrief, runtime thread |
| 8 | `preparation` | preparation actions / plan |
| 9 | `readiness` | evidence append, readiness recompute + snapshots, gaps |

**Rules (enforced in code, not by convention):**
1. **Declare up front, acquire all at once.** An entrypoint calls
   `async with self._locks.hold(*keys):`. `hold` sorts keys by (rank, id) and
   acquires them in that order. Total ordering means no deadlocks.
2. **No nesting.** A `ContextVar` marks an active scope. Calling `hold` inside
   a scope raises `LockOrderError`. Services and skills never take locks
   (same as today's rule 5).
3. **Sequential scopes are allowed.** An entrypoint may run several scopes
   one after another, releasing in between. The standard shape is:
   *aggregate scope* (state transition + AI work + writes), then a
   *`readiness` scope* (append evidence + recompute).
4. **Readiness is idempotent and derived.** Recompute reads all of
   `skill_evidence` and appends a snapshot. Running it in its own scope after
   the aggregate commit is safe: evidence is append-only, so a late recompute
   converges to the same graph. Concurrent recompute requests coalesce: if one
   is queued, later requests join it.
5. **Data-dependent keys use pre-read + re-validate.** Example:
   `complete_interview(session_id)` reads `session.loop_id` without a lock,
   acquires `{loop:<id>, session:<id>}`, re-reads, and retries once if
   `loop_id` changed.
6. **One scope = one DB transaction.** `hold(...)` opens
   `store.transaction()` so a failed flow never leaves partial writes. SQLite
   runs in WAL mode with `busy_timeout`. Writes are serialized by the single
   writer connection, and read connections don't block.
7. **Plugin code (in-process, decision D1) runs inside a scope only for
   synchronous mode hooks** (`mode.prepareTurn`, `mode.reduce`,
   `mode.followUp`). `ctx.evidence(...)` never writes inline: it enqueues to
   the plugin event queue, which persists in a later `readiness` scope. This
   stops plugins from re-entering locks.

**Entrypoint → keys** (representative; the full table is generated from
decorators and checked by a test):

| Entrypoint | Scope 1 | Scope 2 |
|---|---|---|
| `update_settings`, runtime swap | `settings` | — |
| plugin / pack / MCP / question-bank / interview-pack CRUD | `registry` | — |
| `analyze_candidate`, `review_resume`, `generate_stories`, `update_story`, `coach_story` | `candidate` | `readiness` (if evidence) |
| `setup_workspace` | `candidate, targets` | `preparation, readiness` |
| `analyze_target`, `add_target`, `activate_target` | `targets` | `preparation, readiness` |
| `update_target_company_profile`, `set_target_role_pack` | `target:<id>` | `preparation, readiness` |
| `start_interview` | `session:<new>` (+ `loop:<id>` if in a loop) | — |
| `next_question`, `submit_answer` | `session:<id>` | `readiness` |
| `create_debrief` | `session:<id>` | `readiness` |
| `complete_interview` | `loop:<id>?, session:<id>` | `readiness` |
| `start_loop`, `start_loop_from_pack`, `abandon_loop` | `loop:<id>` (+ `registry` read for packs) | — |
| `build_preparation_plan`, `complete_action`, `update_action_status`, `accept_plugin_suggestion`, `fetch_plugin_resources` | `preparation` | `readiness` (if evidence) |
| `recompute_readiness`, `calculate_gaps`, plugin event evidence | `readiness` | — |
| `register_skill_node`, `sync_plugin_modes` | `registry` | — |
| `reset_all`, `import_state` | `exclusive` | — |

**Behaviour this enables:** editing prep, stories or settings while a resume
analysis or interview evaluation runs. Two interview sessions can progress
independently. A long AI call blocks only its own aggregate.

**Rollout.** `LockManager(mode="global" | "fine")`, set by
`INTERVIEW_OS_LOCK_MODE`. In `global` mode every key maps to one lock (today's
semantics) and is used through phases 5–8 so the contract suite measures
parity. Phase 9 (§14) switches the default to `fine`.

**Tests specific to locking:**
- Ordering guard: nested `hold` raises; keys are always acquired sorted.
- Declared-keys test: each entrypoint touches only tables owned by its keys
  (store calls instrumented in test mode).
- Concurrency stress: random concurrent entrypoints on the mock runtime (with
  artificial AI latency) under `fine`. No deadlock within a timeout, and
  afterwards the latest snapshot equals a fresh recompute from
  `skill_evidence`.
- Parity: the contract suite passes in both `global` and `fine` modes.

## 9. AI layer (`ai/`)

```python
class AIRuntime(Protocol):
    kind: RuntimeKind
    async def run_task(self, task: Task, *, on_progress: ProgressCb | None = None) -> dict: ...
    async def send_message(self, session: SessionRef, msg: str, *, schema: dict,
                           on_progress: ProgressCb | None = None) -> dict: ...
    async def probe(self) -> RuntimeStatus: ...
    async def list_models(self) -> list[ModelInfo]: ...
    async def close(self) -> None: ...
```

- `run_structured(skill_id, prompt, model: type[BaseModel])` converts
  Pydantic to JSON Schema, calls the runtime, validates, retries, and raises a
  typed `StructuredOutputError` (invariant #2). Partial-JSON streaming deltas
  are ported from `partialJson.ts`.
- **Codex**: one-shot tasks use `codex exec --json --output-schema <file> -`
  with the prompt on stdin, the read-only sandbox, and
  `cwd=data/codex-workspace`. Sessions use a long-lived `codex app-server` over
  JSON-RPC stdio. Thread ids are persisted in `runtime_sessions` and resumed
  with `thread/resume`.
- **Claude**: the Python Agent SDK with JSON-schema output, one-shot sessions,
  `data/claude-workspace`.
- **opencode**: `opencode run --format json`, prompt and schema on stdin.
- **Devin**: `devin -p --prompt-file <tmp>`, using a workspace temp file.
- **Mock**: deterministic and must support the whole flow. Includes the
  `mode.mock` fallback through plugins.
- `RuntimeManager`: switchable runtime, `GET /api/runtime/available` probe,
  `PUT /api/runtime` hot-swap. The saved `runtimeKind` applies on restart only
  when `INTERVIEW_OS_RUNTIME` is unset.
- Custom providers come only from local `interview-os.runtimes.json`, never
  from HTTP.
- All child processes use `asyncio.create_subprocess_exec(*argv, env=minimal)`
  and never `shell=True`.
- Room for new Python AI work: an `ai/embeddings.py`, local-model, or Whisper
  adapter is added behind the same Protocol and touches no orchestrator code.

## 10. HTTP layer

### 10.1 Routers (1:1 with today)

`workspace, targets, readiness, preparation, interviews, loops, resume,
history, stories, settings, skills, modes, companies, plugins, packs,
interview-packs, question-bank, mcp, export, runtime, documents, examples,
platform, ui, usage`, all mounted under `/api` with the same paths. Handlers
stay thin: validate, call the orchestrator, serialise. No SQL and no skills in
routes.

### 10.2 Errors and validation

- `AppError(code, message, status)` is raised in services and mapped centrally
  by an exception handler to `{ "error": { "code", "message" } }`, the current
  response shape.
- FastAPI's default `422` for body validation is overridden to return the same
  status and shape the `validate` middleware returns today.
- The body limit is ported from `middleware/body-limit.ts`, with per-route
  overrides for uploads and imports.

### 10.3 Streaming contract (exact port of `middleware/stream.ts`)

- Streaming is chosen when `?stream=1` or `Accept: text/event-stream`.
  Otherwise the endpoint returns plain JSON.
- Events: `stage {name}`, `delta {field, text}`, `result <same JSON as
  non-stream>`, `error {code, message}`, and a `ping {}` heartbeat every 10s.
- HTTP status stays 200 once streaming has started.
- A client disconnect **never aborts the operation**. The orchestrator call
  runs in a task shielded from request cancellation, and writes just stop
  landing.

### 10.4 Serving

- `pnpm dev`: Uvicorn `:4100` (reload) plus Vite `:3000`. The `/api` proxy is
  unchanged.
- `pnpm start`: build the SPA, then FastAPI serves `apps/web/dist` and `/api`
  on `:4100`.

## 11. Packs, MCP, documents

- **PackRegistry**: bundled `packs/` plus installed `data/packs/`. Sourced
  items must cite a declared `sources[].id`, and community items are flagged
  unverified (rules unchanged).
- **McpManager**: servers are defined only in local `interview-os.mcp.json`,
  disabled by default, with a per-tool allowlist. Clients are lazy stdio
  clients with a minimal child env.
- **Documents**: PDF and DOCX text extraction. Content is never logged, only
  lengths.

## 12. Plugins (reference)

The plugin system is replaced by the Octop-model design in
**[python-plugin-system.md](./python-plugin-system.md)**. Integration points
with this refactor:

| This refactor | Plugin design section |
|---|---|
| `interview_os/plugins/` package (manifest, context, registry, loader, tools, manager, seed) | §2, §4–§8 |
| Lifespan: `PluginManager.seed_bundled()` then `load_installed()` at startup | §8.2 |
| `plugin-service` hook dispatch → middleware chain + lifecycle hooks from `core/plugin_api.py` | §7.3 |
| `AIRuntime` wrapped by `MiddlewareRuntime` (before/after model) | §7.3 |
| Plugin tools invoked only by orchestrator/UI (D4); `ai/` adapters have no plugin-tool integration at cut-over | §7.1 |
| Interview modes listed by `GET /api/modes` from hook plugins' `modes:` | §7.4 |
| Evidence proposals → `skill_evidence` type `plugin` via orchestrator | §7.5 |
| `/api/plugins` routes **change**: today's `/:id/run`, `/:id/ui/render`, `/:id/ui/frame`, `/:id/ui/data`, `/:id/ui/run`, `/:id/settings` are replaced by the plugin design §9 API | §9 |
| Web plugin screens and chat rendering move to `setup(host)` renderers + `ios_ui` envelope (the only planned frontend change) | §10 |
| `plugin_installs` table is replaced by `data/config.json` `plugins.<id>` (one-time import at first start) | §8.1 |

The trust-model change (in-process plugins) and the `AGENTS.md` edits it
requires are defined in plugin design §12 and repeated in §15 below.

## 13. Testing and parity

1. **Contract suite first** (decision D2: **Python, pytest + httpx**), in
   `tests/contract/`.
   - It speaks only HTTP, against `INTERVIEW_OS_BASE_URL`. A session fixture
     boots either backend (`pnpm --filter @interview-os/server start` or
     `uvicorn interview_os.main:app`) on the mock runtime with a temp data
     dir.
   - It covers every route family, the SSE event sequences (`stage`/`delta`/
     `result`/`error`/`ping`, 200 after start, disconnect does not abort), and
     error shapes and status codes.
   - Fixtures are **recorded from the current Hono backend** as JSON (request,
     normalized response with ids/timestamps masked) and committed under
     `tests/contract/fixtures/`. This keeps reuse without a TS toolchain.
   - It must pass against the current Hono backend before porting starts. It is
     the parity gate and becomes the permanent API test suite after cut-over.
2. **Golden fixtures for `core`**: run the TS readiness, gaps, prioritise and
   state-machine code over fixture inputs, commit the outputs, and require the
   Python port to reproduce them exactly.
3. **Feedback loop**: port `tests/integration/feedback-loop.test.ts` to pytest
   against `InterviewOrchestrator` on the mock runtime. It must always pass
   (product contract).
4. **Runtime tests** use fakes with no tokens. `fake-codex.mjs` is ported to
   `tests/fixtures/fake_codex.py`. Live provider tests stay opt-in via the same
   `INTERVIEW_OS_LIVE_*` env vars.
5. **E2E**: the Playwright suite is unchanged and runs against the FastAPI
   backend on the mock runtime.
6. **Gate**: `uv run ruff check && uv run mypy && uv run pytest`, plus
   `pnpm test:e2e`.

## 14. Migration plan

**Why a parallel build with a single cut-over (not per-route switching):**
both backends would mutate the same SQLite file, and each would have its own
in-process lock. Cross-domain flows (target → workspace → readiness,
loop → interview) would then race. Read-only routes could be proxied early,
but mutating domains must move together.

| Phase | Work | Exit criteria |
|---|---|---|
| 0 | Contract suite + golden fixtures against the current backend | Suite green on Hono |
| 1 | Scaffold `apps/api`: uv, FastAPI app, `core` models, schema export + TS codegen, store over the existing DB, Alembic baseline | Opens a real `data/*.db`, codegen check in CI |
| 2 | Port `core` logic | Golden fixtures identical |
| 3 | Port `ai/` (Mock, then fakes, then Codex, Claude, opencode, Devin) + `run_structured` | Runtime tests green, live tests pass opt-in |
| 4 | Port skills + `SkillHost` | Skill unit tests green on mock |
| 5 | Port orchestrator services (leaf-first: settings, history, export, packs, mcp, story, resume, then target, workspace, readiness, preparation, then interview, loop, debrief) | Python feedback loop green |
| 6 | Port HTTP routers + streaming + static serving | Contract suite green on FastAPI |
| 7 | Plugin system per the plugin design; port `mock_helpers`, then all 9 bundled plugins to Python (D5); write `docs/plugins-migration.md`; update web plugin screens | All 9 ported plugin tests green, feedback loop green with them enabled, E2E green |
| 8 | **Cut-over**: `pnpm dev`/`start` run FastAPI; delete `apps/server`, `packages/runtime`, hand-written `packages/core`; update docs | Full gate green, E2E green |
| 9 | **Fine-grained locks**: switch `INTERVIEW_OS_LOCK_MODE` default to `fine` (§8.1) | Locking tests + stress test green; contract suite green in both modes |

Rollback before phase 8 is free, since the Hono backend stays the default
until cut-over.

## 15. Required documentation changes at cut-over

- Root `AGENTS.md`: repository map (`apps/api` replaces `apps/server` and
  `packages/runtime`), the "How things work" section, Commands (uv/pytest),
  Conventions (Python strict typing, Pydantic at every boundary), the location
  of invariant #1 (`interview_os.core.models`), and invariant #4 (`ai/`).
- Root `AGENTS.md` invariant #8: rewritten per plugin design §12.
- `apps/server/AGENTS.md` / `CLAUDE.md` replaced by `apps/api/AGENTS.md`, with
  the same layer rules in Python terms.
- `ARCHITECTURE.md`, `docs/plugins.md`, `docs/security.md`, `CONTRIBUTING.md`.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Behaviour drift in readiness/gaps math | Golden fixtures (phase 2) |
| HTTP/SSE contract drift breaking the UI | Contract suite is the gate; generated client |
| SQLite schema drift | Identical names; Alembic baseline; test against copies of real DBs |
| Codex app-server session resume differences | Port JSON-RPC client 1:1; fake app-server fixture |
| Claude Python SDK structured-output differences | Opt-in live test before phase 3 exit |
| Plugin trust-model change (D1: in-process for all plugins) | Accepted; trust warning at install, docs updated (plugin design §12) |
| Deadlocks / lost updates with fine-grained locks | Total key ordering, no-nesting guard, pre-read + re-validate, `global` fallback mode, stress test (§8.1) |
| Readiness as a hot key | Separate short `readiness` scopes + recompute coalescing |
| Two toolchains during migration | Ends at cut-over; web stays pnpm |

## 17. Decisions

| # | Decision | Choice | Where |
|---|---|---|---|
| D1 | Third-party plugins in-process? | **Yes**: all plugins load in-process (pure Octop model) | plugin design §12 |
| D2 | Contract test language | **Python** (pytest + httpx), fixtures recorded from Hono | §13 |
| D3 | Lock strategy | **Fine-grained aggregate locks**, `global` mode for parity during porting | §8.1, §14 phase 9 |
| D4 | Plugin tools reaching AI runtimes | **No** at cut-over: orchestrator/UI-only. Backend-hosted MCP later, only with per-skill allowlist + explicit per-tool enable | plugin design §7.1 |
| D5 | TS plugins during migration | **Port all 9 to Python before cut-over**; no Node runner; migration guide | plugin design §13, §14 phase 7 |

No open questions remain in either design.
