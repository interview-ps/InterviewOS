# AGENTS.md — Interview OS

## Mission
Interview OS is an open-source, local-first interview-preparation OS. It builds and continuously
updates an **evidence-backed model of a candidate's interview readiness**, then uses it to plan
preparation and to run interviews that deliberately retest weak areas. It is not a random
interview-question generator. See `ARCHITECTURE.md` for the full design.

The backend is Python/FastAPI (`apps/api`); the UI is React (`apps/web`) over the shared design
system (`packages/ui`) and generated types (`packages/frontend-types`).

## Core invariants (do not break)
1. **No skill may create its own independent candidate model.** All state shapes live in
   `apps/api/src/interview_os/core/models` (Pydantic). Import them; never redefine them.
2. **AI-generated state mutations must pass schema validation** (`run_structured` in
   `apps/api/src/interview_os/skills/framework`) before anything is persisted. Malformed output → retry → typed error.
3. **The readiness graph must remain evidence-backed.** Scores are derived from `skill_evidence`
   by `core/readiness`; snapshots are appended, never overwritten; every exposed score carries
   its evidence ids.
4. **Runtime-specific logic stays behind `AIRuntime`.** Only `ai/` knows about a provider
   (Codex, Claude Code, opencode, Devin); one-shot tasks and session threads are its concern.
5. The orchestrator contains workflow, not domain intelligence. Skills are small and single-purpose.
6. Resumes, JDs, answers, company notes and uploaded documents are untrusted: never put them
   in process argv or shell strings, never log their contents (lengths only), never expose a
   shell to the browser.
7. Never log or return secrets/tokens. Provider auth is handled by the provider's own local
   install (`codex login`, `claude`, `opencode auth login`, `devin auth login`).
8. **All skill calls go through `SkillHost`.** Never call `skill.execute` from orchestrator or
   API code. Manifests declare inputs/permissions; the host rejects undeclared input keys,
   gates `ctx.runtime` behind `runtime.invoke`, and `host.assert_can(id, "<x>.write")` must pass
   before persisting a skill's outputs. Plugins run **in-process** (pure Octop model, trust
   accepted up front — see `docs/design/python-plugin-system.md` §12); they receive only the
   state slices they declare *and* the user has granted. A plugin manifest may request
   `evidence.write` — the only `*.write` allowed (all others are rejected at load) — and even
   then evidence is **proposal-only**: schema-validated, confidence-capped, stored as type
   `plugin` with its source, and written by the orchestrator only when the user granted the permission.
   MCP servers are defined only in the local `interview-os.mcp.json` file (never via HTTP),
   are disabled by default, and each tool requires an explicit allowlist entry.
   Packs distinguish `sourced` items (must cite a declared `sources[].id`) from `community`
   items (displayed as unverified).
   Plugin UI appears only through declared slots — declarative trees rendered by the host,
   or plugin-authored components in sandboxed opaque-origin iframes reached via the
   postMessage bridge; never same-origin plugin code, global CSS, or remote scripts.
   Core talks to plugins only through the `PLUGIN_HOOKS` contracts
   (`apps/api/src/interview_os/core/plugin_api.py`) — never add plugin-specific
   code to core. AI runtime providers are trusted local code loaded only from
   `interview-os.runtimes.json` (like `interview-os.mcp.json`, never HTTP).

## Repository map
```
apps/api            FastAPI API :4100, owns SQLite + provider child processes
apps/web            Vite + React Router + Tailwind UI :3000 (dev proxies /api → API;
                    the built SPA in apps/web/dist is served by the API)
packages/frontend-types  generated model types (from apps/api/schema) + the plugin-UI
                    vocabulary, taxonomy and voice constant (@interview-os/frontend-types)
packages/ui         shared design system (@interview-os/ui): tokens/theme.css, components,
                    declarative UINode renderer, and the plugin-frame runtime bundle
apps/api/src/interview_os/core   Pydantic models (single source of state shapes), taxonomy,
                    readiness, gaps, prioritize, state machine, serialization, logger, ids, errors
apps/api/src/interview_os/ai     AIRuntime, MockRuntime, acp/ (opencode, devin), codex/, claude/, middleware
apps/api/src/interview_os/skills skill framework + SkillHost; the built-in skills and their
                    deterministic mocks (resume-analyzer, jd-analyzer, gap-analyzer,
                    company-profiler, prep-planner, star-coach, resume-coach, interviewer,
                    answer-evaluator, interview-debrief, loop-debrief)
apps/api/src/interview_os/orchestrator  InterviewOrchestrator facade (LockManager + composition)
                    delegating to domain services (settings, workspace, targets, readiness,
                    preparation, interview, loop, debrief, history, story, resume, plugin, pack,
                    mcp, export) over a shared WorkflowContext + store
apps/api/src/interview_os/plugins  in-process plugin host (manifest/context/registry/loader/
                    tools/manager/seed/dispatch/bootstrap) + the SkillHost adapter (inproc)
apps/api/src/interview_os/api   FastAPI routers, SSE streaming, error mapping, serialization,
                    body limits, static serving
apps/api/src/interview_os/{packs,mcp}  PackRegistry; McpManager
apps/api/schema     generated JSON Schema export (Pydantic) — regenerate on model changes
examples/           seed resumes + JDs (backend-engineer is canonical)
plugins/            bundled plugins (Python: plugin.yaml + main.py). Every non-mixed interview
                    mode ships here (technical-mode, behavioral-mode, hiring-manager-mode,
                    hr-mode, system-design-mode, coding-mode) plus interview-day-checklist,
                    learning-resources, postgres-interviewer
packs/              bundled packs (companies/, roles/, interview/)
data/               SQLite db, runtime workspaces, installed plugins/packs, config.json — gitignored
tests/contract      Python HTTP contract suite (spawns FastAPI by default)
tests/e2e           Playwright on the mock runtime
tests/golden        core parity fixtures (JSON), read by the apps/api tests
tests/fixtures      fake-codex / fake-acp-agent fixtures, etc.
docs/               design docs (fastapi-backend-refactor.md, python-plugin-system.md,
                    acp-runtime.md, notes/)
CLAUDE.md           Claude Code entrypoint (imports @AGENTS.md)
.claude/ .opencode/ agent settings
```

## How things work
- **Shared state**: `InterviewOSState` is assembled by the store from SQLite. Skills get typed
  slices as input and return typed outputs; the orchestrator applies them as mutations.
- **Skills**: `InterviewSkill[I, O] { id, manifest, input_schema, output_schema, execute(input, ctx) }`.
  AI skills call `run_structured` → `ctx.runtime.run_task` (or `send_message` for the interviewer's
  session thread). Prompts live in each skill's `prompt.py`.
- **Codex runtime**: one-shot tasks use `codex exec --json --output-schema … -` (prompt on stdin,
  read-only sandbox, cwd `data/codex-workspace`). Interview sessions use a backend-owned
  `codex app-server` (JSON-RPC over stdio); Interview OS session ↔ Codex thread id is persisted
  in `runtime_sessions` and resumed with `thread/resume`.
- **Claude runtime**: `@anthropic-ai/claude-agent-sdk` via a lazy Python import, `outputFormat:
  json_schema`; one-shot (`run_task`); sessions are local one-shot wrappers (`data/claude-workspace`).
- **opencode / Devin (ACP runtime)**: `ai/acp/` drives each provider as an ACP *agent*
  subprocess (`opencode acp`, `devin acp`) — JSON-RPC 2.0 over the agent's stdio, one
  long-lived process per runtime. Interview OS is the ACP *client*: it advertises no
  fs/terminal capability, always rejects `session/request_permission`, and sends prompts only
  in `session/prompt` content blocks on stdin (never argv/env). Interview sessions use
  `session/new`/`session/load`; one-shot tasks use a throwaway session. See
  `docs/design/acp-runtime.md`.
- **MockRuntime**: deterministic; `INTERVIEW_OS_RUNTIME=mock`. Must support the whole flow.
- **RuntimeManager**: `create_runtime` returns a switchable `AIRuntime`; Settings can probe
  (`GET /api/runtime/available`) and hot-swap (`PUT /api/runtime`) providers. The saved
  `runtimeKind` setting applies on restart only when `INTERVIEW_OS_RUNTIME` is unset.
- **AI usage**: every runtime reports usage through an `AIUsageSink` (injected via
  `RuntimeManager`) into the append-only `ai_usage` table — ACP (opencode/Devin) sends
  context + cost via `session/update` `usage_update` and per-turn tokens on the
  `session/prompt` result (End-Turn Token Usage RFD); Codex reads `turn.completed.usage`;
  Claude reads the SDK result's `usage`/`total_cost_usd`. Surfaced at `GET /api/ai-usage`
  (with `from`/`to`/`runtime`/`session` filters and a `DELETE` to clear) and the Usage page;
  totals/breakdowns are summed in SQL (`GROUP BY`), with per-model breakdown and an optional
  display-only monthly budget in Settings.
- **Plugins**: in-process Octop model — a plugin is `plugin.yaml` + `main.py` (`setup(ctx)`
  registers tools/skills/middleware). `PluginManager` seeds/loads/enables; `PluginRegistry`
  holds the middleware chain; `PluginDispatcher` runs lifecycle hooks. The plugin service drives
  them through `SkillHost` via `plugins/inproc.py`. Config lives in `data/config.json`.
- **Locking**: `LockManager` defaults to `fine` (one lock per scope key, acquired in a total
  order); `INTERVIEW_OS_LOCK_MODE=global` is the parity fallback.

## Commands
```
pnpm install
pnpm dev                          # Vite dev UI :3000 (proxies /api → :4100)
pnpm dev:api                      # FastAPI on :4100 (uvicorn)
pnpm build                        # build the SPA into apps/web/dist
pnpm start                        # build + serve UI and API together on :4100
INTERVIEW_OS_RUNTIME=mock pnpm dev:api
INTERVIEW_OS_RUNTIME=claude pnpm dev:api
INTERVIEW_OS_RUNTIME=opencode pnpm dev:api
INTERVIEW_OS_RUNTIME=devin pnpm dev:api
pnpm typecheck                    # tsc for the surviving TS packages
pnpm test                         # apps/api pytest (unit + runtime + integration)
pnpm test:contract                # Python HTTP contract suite (spawns FastAPI, mock runtime)
pnpm test:e2e                     # Playwright on mock runtime (serves the built SPA + API)
cd apps/api && uv run ruff check && uv run mypy src tests && uv run pytest
uv run --project apps/api python scripts/generate_ts_types.py packages/frontend-types/src/generated.ts
uv run --project apps/api python -m interview_os.export_schema   # regenerate openapi.json + schema/*
INTERVIEW_OS_LIVE_CODEX=1 …       # opt-in live provider tests (codex/claude/opencode/devin)
```

## Testing requirements
- Unit tests for state transitions, gaps, readiness/evidence aggregation, prioritisation, schemas.
- Runtime tests use `tests/fixtures/fake-codex.mjs` (no tokens). Live provider tests are opt-in.
- `apps/api/tests/integration/test_feedback_loop.py` is the product: it must always pass.
- `tests/contract/` (Python, black-box HTTP) and `tests/golden/` (core outputs as JSON) are the
  parity gates. Any intended API or core-logic change must re-record them in the same change.
  `/api/test/reset` does not wipe `mcp_servers`, `external_contexts`, `plugin_settings`,
  `plugin_storage`; contract tests touching these isolate themselves.
- A feature is not done because it compiles; run the tests.

## Conventions
Python strict typing (`ruff` + `mypy --strict`), Pydantic at every boundary, small modules, no
comments restating code, argv arrays for child processes, no new dependency without checking the
existing stack covers it. The surviving TypeScript (web/ui/frontend-types) stays strict + ESM.

## Not yet
Cover letters, LinkedIn optimisation, job-search automation, offer comparison, salary
negotiation, web-researched company-profile libraries, large question banks, multi-user/collab.
