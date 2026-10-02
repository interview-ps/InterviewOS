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

## Features (v0.1)

- Resume + JD analysis into typed candidate/target profiles (Zod-validated AI output).
- Evidence-backed readiness graph with append-only score snapshots.
- Gap analysis and a concrete, reprioritizing prep plan.
- State-machine-driven mock interviews with per-question selection reasons.
- 7-dimension answer evaluation feeding evidence back into readiness.
- Deliberate weak-skill retesting in subsequent sessions.
- Full evidence/audit trail per skill, persisted in local SQLite.
- Deterministic mock runtime for development and tests — no AI calls needed.

## Local Codex integration

Interview OS talks to a locally installed [Codex](https://github.com/openai/codex)
CLI — no API keys or secrets pass through the app:

- **Detection**: `codex` is found on `PATH` (or `INTERVIEW_OS_CODEX_BIN`) and
  probed with `--version`.
- **One-shot tasks** (analysis, evaluation, debrief): `codex exec` with a strict
  JSON output schema; the prompt is piped on stdin — untrusted resume/JD/answer
  text never appears in argv or shell strings.
- **Interview sessions**: a backend-owned `codex app-server` process
  (JSON-RPC over stdio) keeps an interviewer thread per session; thread ids are
  persisted and resumed across restarts.
- **Sandbox**: read-only workspace under `data/codex-workspace`; approval
  requests are always declined.
- **Environment**: child processes receive an allowlisted environment only.

## Installation

- Node.js 24 (developed and tested on v24.x), [pnpm](https://pnpm.io) 12
- For the real AI runtime: Codex CLI on `PATH` (`codex --version`)

```sh
git clone <repo> && cd InterviewOS
pnpm install
```

## Quick start

```sh
pnpm dev          # server :4100 + web :3000
```

Open http://localhost:3000 and set a target role (or load a bundled example).

## Mock runtime

No Codex installed? Run fully deterministically:

```sh
INTERVIEW_OS_RUNTIME=mock pnpm dev
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `INTERVIEW_OS_RUNTIME` | `codex` | `codex` or `mock` |
| `INTERVIEW_OS_RUNTIME_FALLBACK` | — | `mock` to fall back when Codex is unavailable |
| `INTERVIEW_OS_CODEX_BIN` | `codex` on PATH | Path to the Codex executable |
| `INTERVIEW_OS_CODEX_TIMEOUT_MS` | `120000` | Per-task timeout |
| `INTERVIEW_OS_CODEX_WORKSPACE` | `data/codex-workspace` | Read-only sandbox dir |
| `INTERVIEW_OS_PORT` | `4100` | API server port |
| `INTERVIEW_OS_DB` | `data/interview-os.db` | SQLite database path |

## Testing

```sh
pnpm typecheck && pnpm test     # unit + runtime (fake codex) + integration
pnpm test:e2e                   # Playwright over the mock runtime
INTERVIEW_OS_LIVE_CODEX=1 pnpm test:codex   # opt-in live Codex test
```

`tests/integration/feedback-loop.test.ts` is the canonical product test: it
walks the full loop and asserts the weak-skill retest behaviour end to end.

## Project structure

```
apps/server         Hono API :4100, owns SQLite + Codex child processes
apps/web            Next.js + Tailwind UI :3000 (/api → server)
packages/shared     logger (redacting), ids, errors
packages/core       schemas, taxonomy, readiness math, gaps, prioritization, state machine
packages/runtime    AIRuntime, MockRuntime, codex/ (exec adapter + app-server)
packages/skills     resume/jd/gap analyzers, prep-planner, interviewer, evaluator, debrief
packages/orchestrator InterviewOrchestrator + SQLite store (drizzle/better-sqlite3)
examples/           seed resumes + JDs (backend-engineer is canonical)
tests/              integration, fixtures/fake-codex.mjs, e2e (Playwright)
```

## Roadmap (v0.2+)

Cover letters, LinkedIn optimisation, job-search automation, offer comparison,
salary negotiation, company-profile libraries, larger question banks, PDF
parsing, multi-user/collaboration.

## Acknowledgements

Ideas inspired by
[Paramchoudhary/ResumeSkills](https://github.com/Paramchoudhary/ResumeSkills)
(MIT) and [jennifer88huang/interview-skills](https://github.com/jennifer88huang/interview-skills).
No code was copied; Interview OS is independently implemented.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the invariants in [AGENTS.md](AGENTS.md).

## License

MIT — interview.ps
