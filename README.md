# Interview OS

A local-first interview-preparation system that keeps a continuously updated,
evidence-backed model of your interview readiness — and drives preparation and
mock interviews from it.

## What it is

Interview OS analyzes your resume against a target job description, computes a
per-skill readiness graph backed by explicit evidence, builds a concrete prep
plan, and runs mock interviews that deliberately retest your weak areas. Every
readiness score is traceable to the evidence that produced it.

## Why it exists

Question generators produce a list of questions. Interview OS runs a feedback
loop instead:

```
Resume + JD → resume-analyzer → jd-analyzer → gap-analyzer → prep-planner
→ interview (planner + interviewer) → answer-evaluator → evidence
→ readiness recompute → prep-planner update → next interview retests weak skills ↺
→ interview-debrief
```

A weak answer on cache invalidation doesn't just get noted — it becomes
evidence, lowers that skill's readiness score, reprioritizes your prep plan,
and makes a follow-up question on the same weakness more likely next round.

## Demo workflow

1. `pnpm dev`, open http://localhost:3000, go to **Target Role**.
2. Load the `backend-engineer` example — a Python/APIs-strong candidate
   applying to a Senior Backend Engineer role heavy on caching and distributed
   systems.
3. Analyze → the gap analysis surfaces distributed-systems/caching/system-design
   gaps and generates a prep plan.
4. **Interview** → the first question probes caching consistency. Answer it
   vaguely ("I'd put Redis in front of the database") → the evaluator records
   weak evidence on `distributed-systems.caching.cache-invalidation`.
5. **Readiness** → that skill now shows `weak`, backed by the evidence entry
   from your answer; **Prep Plan** reprioritizes an invalidation practice
   action to #1.
6. Start another interview → the first question retests the weakness.

## Architecture

```
┌──────────────────────────────────────────┐
│              INTERVIEW OS                │
├──────────────────────────────────────────┤
│ Applications                             │
│ Resume │ Prep │ Interview │ Readiness    │
├──────────────────────────────────────────┤
│ Skills                                   │
│ JD │ Resume │ Gap │ Interview │ Evaluate │
├──────────────────────────────────────────┤
│ Orchestration                            │
│ Planner │ Router │ Session │ State       │
├──────────────────────────────────────────┤
│ Intelligence                             │
│ Candidate │ Gap │ Readiness │ Evaluation │
├──────────────────────────────────────────┤
│ Runtime                                  │
│ Local Codex │ Mock │ Future Providers    │
└──────────────────────────────────────────┘
```

## Features (v0.2)

- Resume + JD analysis into typed candidate/target profiles (Zod-validated AI output).
- Evidence-backed readiness graph with append-only score snapshots, now with
  **time decay**: evidence weights halve at type-specific half-lives
  (interview answers 60 d, practice 45 d, self-reports 30 d, resume claims 180 d).
- Gap analysis and a concrete, reprioritizing prep plan.
- **Practice sessions**: single-question sessions focused on one prep action
  ("verify with a question"); answers produce `practice` evidence and
  auto-complete the action at a demonstrated score ≥ 0.7.
- **Self-check completion**: ticking success criteria on a prep action records
  one `self_report` evidence entry (score = met/total criteria, confidence 0.5).
- **Multiple targets per candidate**: add additional role targets that reuse the
  same resume; evidence/readiness are shared while gaps, plans and sessions are
  scoped per target. Switch targets from the header or the Target Role page.
- **Document upload**: resume/JD inputs accept PDF, DOCX, TXT and Markdown;
  extraction is server-side, in-memory, detected by magic bytes (5 MB limit,
  50k-char output cap).
- **Live streaming UX** (SSE): setup, target analysis, question generation,
  evaluation and debrief stream stage updates and partial text to the UI —
  question text and evaluation summaries type in live.
- **Runtime settings**: Codex model, reasoning effort and task mode
  (`app-server` warm process, default | `exec` per-task spawn) are configurable
  from Settings, persisted in SQLite, and applied on the next AI call.
- State-machine-driven mock interviews with per-question selection reasons.
- **Round types** (§8.4): `mixed`, `technical`, `system_design`, `behavioral`,
  `hr`. Rounds filter the candidate pool for question selection (including the
  every-4th-question strong-area confirmation); an empty pool in a focused
  round falls back to that round's taxonomy nodes. The interviewer adopts a
  per-round persona (e.g. scale numbers + requirements→estimation→trade-offs
  for system design; STAR prompts for behavioral).
- **STAR evaluation**: behavioral/HR answers get a `star` assessment
  (Situation/Task/Action/Result + notes); missing parts become a
  `communication` weakness and a prep action.
- **STAR story bank + coach**: stories extracted from your resume or generated
  on demand live under **Stories** — editable, and coachable via
  `star-coach.review` (feedback, missing parts, an improved draft).
- **Company profile**: optional careers-page notes (untrusted, delimited for
  the model) are profiled into values/interview style/focus skills/behavioral
  themes; focus skills boost matching JD requirements by +0.05 (cap 0.95) and
  themes reach the behavioral/HR interviewer.
- 7-dimension answer evaluation feeding evidence back into readiness.
- Deliberate weak-skill retesting in subsequent sessions.
- Full evidence/audit trail per skill, persisted in local SQLite.
- Deterministic mock runtime for development and tests — no AI calls needed.

### API additions (v0.2)

| Route | Purpose |
|---|---|
| `POST /api/preparation/:id/complete` | Self-check: `{checkedCriteria: string[]}` → `self_report` evidence + `done` |
| `GET /api/targets` / `POST /api/targets` / `POST /api/targets/:id/activate` | Multi-target management |
| `POST /api/documents/extract` | Multipart `file` → `{text, format, pages?, warnings}` |
| `POST /api/interviews` | extended with `{mode: "practice", focusSkillId, actionId, roundType}` |
| `GET /api/settings` / `PUT /api/settings` | `{model, reasoningEffort, taskMode}` — validated against the live model list; a vanished model falls back to the provider default |
| `GET /api/runtime/models` | Codex model catalog (`model/list`) |
| `GET /api/stories` | STAR story bank for the active candidate |
| `POST /api/stories/generate` | `star-coach.generate` → new stories (source `generated`, deduped by title) |
| `PATCH /api/stories/:id` | Edit a story (source becomes `user`) |
| `POST /api/stories/:id/coach` | `star-coach.review` → feedback, missing parts, improved draft |

Long-running POSTs (`workspace/setup`, `targets`, `interviews`,
`interviews/:id/next|answer|complete`, `stories/generate`, `stories/:id/coach`) also accept `?stream=1` or
`Accept: text/event-stream` and then emit SSE `stage`/`delta`/`result`/`error`
events instead of a single JSON response.

## AI runtimes

Interview OS selects its AI backend with `INTERVIEW_OS_RUNTIME`. Every backend
implements the same `AIRuntime` interface, and only `packages/runtime` knows
about any specific provider.

| Runtime | `INTERVIEW_OS_RUNTIME` | Transport | Structured output | Sessions |
|---|---|---|---|---|
| Codex (default) | `codex` | `codex app-server` / `codex exec` | `--output-schema` | app-server thread |
| Claude Code | `claude` | `@anthropic-ai/claude-agent-sdk` | `outputFormat: json_schema` | one-shot wrapper |
| opencode | `opencode` | one-shot `opencode run --format json` | JSON reply parsed client-side | one-shot wrapper |
| Mock | `mock` | in-process | deterministic | in-memory |

For Claude and opencode, log in once with the provider's own tooling
(`claude`, `opencode auth login`); Interview OS reads no API keys itself.
Child processes receive an allowlisted environment only.

### Local Codex integration

Interview OS talks to a locally installed [Codex](https://github.com/openai/codex)
CLI —" no API keys or secrets pass through the app:

- **Detection**: `codex` is found on `PATH` (or `INTERVIEW_OS_CODEX_BIN`) and
  probed with `--version`.
- **One-shot tasks** (analysis, evaluation, debrief) run on the shared
  `codex app-server` process as ephemeral threads by default —" warm start,
  `item/agentMessage/delta` events streamed to the caller —" or via `codex exec`
  (`taskMode: "exec"` in Settings) with a strict JSON output schema; the prompt
  is piped on stdin —" untrusted resume/JD/answer text never appears in argv or
  shell strings.
- **Interview sessions**: a backend-owned `codex app-server` process
  (JSON-RPC over stdio) keeps an interviewer thread per session; thread ids are
  persisted and resumed across restarts.
- **Streaming**: agent-message deltas surface as `{type:"delta"}` runtime
  events → `runStructured` extracts the configured `streamField` mid-generation
  → SSE to the browser.
- **Model & effort**: selectable per task (`model`/`effort` on `AgentTask` /
  `RuntimeMessage`, from `model/list`); applied via app-server params or
  `codex exec -m <model> -c model_reasoning_effort="<effort>"`. Invalid values
  are rejected before anything spawns.
- **Sandbox**: read-only workspace under `data/codex-workspace`; approval
  requests are always declined.
- **Environment**: child processes receive an allowlisted environment only.

### Claude Code (`INTERVIEW_OS_RUNTIME=claude`)

Uses the official Agent SDK. Structured tasks set
`outputFormat: { type: "json_schema", schema }` and read the result's
`structured_output`. Each call is one-shot; `createSession` returns a local
opaque `threadId` and `sendMessage` runs a fresh task with the full prompt (no
server-side resume). `listModels()` uses the SDK's `supportedModels()` and falls
back to `default`/`sonnet`/`opus`/`haiku` aliases when unavailable.

### opencode (`INTERVIEW_OS_RUNTIME=opencode`)

Runs the opencode CLI once per task: `opencode run --format json [-m
provider/model]`. There is no `opencode serve` process and no SDK. The prompt —
instructions, JSON Schema and input — is written to the child's **stdin** (never
argv, so untrusted text is never shell-interpreted and Windows `.cmd` shims
work); the assistant `text` parts are collected from the NDJSON stream and the
JSON reply is parsed as the structured output. `INTERVIEW_OS_OPENCODE_TIMEOUT_MS`
bounds each task. Model ids are provider-qualified (`provider/model`, e.g.
`anthropic/claude-sonnet-5`) from `opencode models`.

## Installation

- Node.js 24 (developed and tested on v24.x), [pnpm](https://pnpm.io) 12
- For the real AI runtime: Codex CLI on `PATH` (`codex --version`), or Claude
  Code (`claude`) / opencode (`opencode`) for the alternative runtimes

```sh
git clone <repo> && cd InterviewOS
pnpm install
```

Examples below use POSIX shell syntax (`VAR=value command`). On Windows
PowerShell, set the variable first or use its own syntax — see
[Environment variables on Windows](#environment-variables-on-windows).

## Quick start

```sh
pnpm dev          # server :4100 + web :3000
```

Open http://localhost:3000 and set a target role (or load a bundled example).

### Running on Windows

Interview OS runs locally on Windows. The only common obstacle is an
Application Control / Device Guard policy that blocks `pnpm.exe`; the server and
web app themselves are fine, including the `better-sqlite3` native module.

- If `pnpm ...` fails with `was blocked by your organization's Device Guard
  policy`, use `corepack pnpm <args>` instead. The root `dev` / `typecheck`
  scripts already call `corepack pnpm` internally, so `corepack pnpm dev` and
  `corepack pnpm typecheck` work.
- `corepack pnpm dev` starts both apps (server :4100, web :3000). Verify the API
  directly at http://localhost:4100/api/runtime/status.
- The test runner (`vitest`) may fail to start on such hosts because a
  `rolldown` native binding is blocked. That is independent of SQLite; run the
  tests on an unlocked machine or in CI.

## Mock runtime

No Codex installed? Run fully deterministically:

```sh
INTERVIEW_OS_RUNTIME=mock pnpm dev
```

```powershell
$env:INTERVIEW_OS_RUNTIME="mock"; pnpm dev   # Windows PowerShell
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `INTERVIEW_OS_RUNTIME` | `codex` | `codex`, `mock`, `claude`, or `opencode` |
| `INTERVIEW_OS_RUNTIME_FALLBACK` | — | `mock` to fall back when the selected runtime is unavailable |
| `INTERVIEW_OS_CODEX_BIN` | `codex` on PATH | Path to the Codex executable |
| `INTERVIEW_OS_CODEX_TIMEOUT_MS` | `120000` | Per-task timeout |
| `INTERVIEW_OS_CODEX_WORKSPACE` | `data/codex-workspace` | Read-only sandbox dir |
| `INTERVIEW_OS_CLAUDE_BIN` | `claude` on PATH | Path to the Claude Code executable |
| `INTERVIEW_OS_CLAUDE_TIMEOUT_MS` | `120000` | Per-task timeout |
| `INTERVIEW_OS_CLAUDE_WORKSPACE` | `data/claude-workspace` | Working dir for Claude tasks |
| `INTERVIEW_OS_OPENCODE_BIN` | `opencode` on PATH | Path to the opencode executable |
| `INTERVIEW_OS_OPENCODE_TIMEOUT_MS` | `120000` | Per-task timeout |
| `INTERVIEW_OS_OPENCODE_WORKSPACE` | `data/opencode-workspace` | Working dir for opencode |
| `INTERVIEW_OS_PORT` | `4100` | API server port |
| `INTERVIEW_OS_DB` | `data/interview-os.db` | SQLite database path |
| `INTERVIEW_OS_MOCK_DELAY_MS` | `0` | Per-chunk delay for mock streamed deltas (demo the streaming UX without Codex) |

### Environment variables on Windows

The `VAR=value command` form is POSIX-shell only. On Windows, set the variable
first, or inline it per shell:

| Shell | Set for the session | Inline for one command |
|---|---|---|
| PowerShell | `$env:INTERVIEW_OS_RUNTIME="opencode"` | `$env:INTERVIEW_OS_RUNTIME="opencode"; pnpm dev` |
| cmd.exe | `set INTERVIEW_OS_RUNTIME=opencode` | `set INTERVIEW_OS_RUNTIME=opencode && pnpm dev` |

## Testing

POSIX shell:

```sh
pnpm typecheck && pnpm test     # unit + runtime (fake codex) + integration
pnpm test:coverage              # same tests, minimum 70% line coverage
pnpm test:e2e                   # Playwright over the mock runtime
INTERVIEW_OS_LIVE_CODEX=1 pnpm test:codex        # opt-in live Codex unit test
INTERVIEW_OS_LIVE_CLAUDE=1 pnpm test:claude      # opt-in live Claude smoke
INTERVIEW_OS_LIVE_OPENCODE=1 pnpm test:opencode  # opt-in live opencode smoke
INTERVIEW_OS_LIVE_CODEX=1 pnpm test:e2e:live     # opt-in live Codex end-to-end
```

Windows PowerShell:

```powershell
$env:INTERVIEW_OS_LIVE_OPENCODE="1"; pnpm test:opencode
```

`tests/integration/feedback-loop.test.ts` is the canonical product test: it
walks the full loop and asserts the weak-skill retest behaviour end to end.

### Continuous integration

GitHub Actions runs on pull requests and pushes to `main`. It installs the locked
pnpm dependencies on Node.js 24, typechecks the workspace, runs the Vitest unit
and integration suite with a 70% line coverage minimum, and builds the Next.js
app. The coverage check measures package source, the API server, and web library
modules; it does not measure Next.js UI components. The workflow does not run
Playwright or live AI provider tests. It can also be started manually from the
Actions tab.

## Project structure

```
apps/server         Hono API :4100, owns SQLite + provider child processes
apps/web            Next.js + Tailwind UI :3000 (/api → server)
packages/shared     logger (redacting), ids, errors
packages/core       schemas, taxonomy, readiness math, gaps, prioritization, state machine
packages/runtime    AIRuntime, MockRuntime, codex/ (exec adapter + app-server), claude/ (SDK), opencode/ (CLI)
packages/skills     resume/jd/gap/company analyzers, prep-planner, star-coach, interviewer, evaluator, debrief
packages/orchestrator InterviewOrchestrator + SQLite store (drizzle/better-sqlite3)
examples/           seed resumes + JDs (backend-engineer is canonical)
tests/              integration, fixtures/fake-codex.mjs, e2e (Playwright)
```

## Roadmap (v0.3+)

Resume re-upload with versioned claims, voice mode, real company research
(beyond pasted notes), cover letters, LinkedIn optimisation, job-search
automation, offer comparison, salary negotiation, company-profile libraries,
larger question banks, multi-user/collaboration.

## Acknowledgements

Ideas inspired by
[Paramchoudhary/ResumeSkills](https://github.com/Paramchoudhary/ResumeSkills)
(MIT) and [jennifer88huang/interview-skills](https://github.com/jennifer88huang/interview-skills).
No code was copied; Interview OS is independently implemented.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the invariants in [AGENTS.md](AGENTS.md).

## License

MIT — interview.ps
