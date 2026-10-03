# Interview OS — Implementation Plan (v0.1)

Vertical slices; each phase ends green (`pnpm typecheck && pnpm test`).

- [x] **P1 Repo + schemas** — pnpm workspace, TS strict, Vitest; `shared` (logger, ids);
      `core` schemas, taxonomy, readiness math, gaps, prioritisation, state machine + unit tests.
- [x] **P2 Runtime** — `AIRuntime`, `MockRuntime`, `LocalCodexRuntime` (detect, exec adapter,
      app-server process/protocol/sessions/event parser). Runtime tests against
      `tests/fixtures/fake-codex.mjs` (unavailable, available, crash, malformed event, malformed
      output, timeout, session resume). Opt-in live test `INTERVIEW_OS_LIVE_CODEX=1`.
- [x] **P3 Analyzers** — resume-analyzer, jd-analyzer (+ `runStructured` retry/validation).
- [x] **P4 Gaps + readiness graph** — gap-analyzer skill on core/gaps; SQLite store, evidence, snapshots.
- [x] **P5 Prep planner** — concrete actions with success criteria; dedupe per skill.
- [x] **P6 Interview session** — state machine persisted; interview planner + interviewer; Codex thread mapping.
- [x] **P7 Answer evaluator** — 7 dimensions, evidence extraction.
- [x] **P8 Feedback loop** — evaluation → evidence → readiness → plan → next question retests weakness;
      canonical integration test `tests/integration/feedback-loop.test.ts` (must pass); debrief.
- [x] **P9 UI** — Dashboard, Target Role, Prep Plan, Interview, Readiness (tree + evidence), History,
      Settings (Local Codex); runtime badge.
- [x] **P10 Polish** — Playwright E2E on mock runtime, README, CONTRIBUTING, examples, live Codex smoke.

## v0.2 (see ARCHITECTURE §8)
- [x] **V1 Loop depth + documents** — time decay, practice/self-check evidence, practice sessions,
      multiple targets per candidate, PDF/DOCX extraction.
- [x] **V2 Live Codex UX** — app-server task mode, streaming deltas + SSE, settings (model, effort, task
      mode), live-Codex E2E pass.
- [x] **V3 Interview breadth** — round types, STAR evaluation + story bank + coach, company profile.

## v0.3 (see ARCHITECTURE §9)
- [x] **W1 Modes + engine** — per-mode modules (technical, coding, system design, behavioral, hiring manager, HR),
      rubrics, mode state, follow-ups, adaptive engine v3, company profiles, new navigation.
- [x] **W2 Loops + history** — full loops with cross-round handoff, loop debrief, enriched history, metrics.
- [x] **W3 Resume + plugins** — ATS checks, resume coach with no-new-facts guard, manifests/permissions/host,
      plugin loader + sample plugin, command palette.
- [x] **W4 Polish** — app-grade UI pass, E2E, live Codex verification, docs.

Non-goals v0.3: voice/video, application automation, recruiter CRM, marketplace, billing, enterprise, mobile.

Deferred to v0.4+: cover letters, LinkedIn, job search, offer comparison, salary negotiation,
company profile library/web research, large question banks, multi-user, collaboration.
