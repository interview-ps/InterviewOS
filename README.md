<p align="center">
  <img src="apps/web/public/interview-ps-logo.png" alt="Interview OS logo" width="112" />
</p>

<h1 align="center">Interview OS</h1>

<p align="center">
  <strong>Turn interview practice into a feedback loop.</strong><br />
  A local-first workspace that uses evidence from your answers to guide what you prepare next.
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#how-it-works"><strong>How it works</strong></a> &middot;
  <a href="#features"><strong>Features</strong></a> &middot;
  <a href="#architecture"><strong>Architecture</strong></a> &middot;
  <a href="#contributing"><strong>Contributing</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/interview-ps/InterviewOS/actions/workflows/ci.yml"><img src="https://github.com/interview-ps/InterviewOS/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/interview-ps/InterviewOS/stargazers"><img src="https://img.shields.io/github/stars/interview-ps/InterviewOS?style=flat" alt="GitHub stars" /></a>
</p>

<br />

## Prepare for the interview you are actually facing

Interview OS reads your resume and a target job description, maps the skills that
matter for that role, and builds a preparation plan. Practice sessions and mock
interviews then add evidence to a readiness graph. A weak answer changes your
next practice action and the questions you see in a later interview.

| | Step | What happens |
| --- | --- | --- |
| **01** | **Set a target** | Compare your resume with a job description and identify skill gaps. |
| **02** | **Prepare** | Work through a plan focused on the most important gaps. |
| **03** | **Interview and improve** | Answer questions, review evidence-backed feedback, and retest weak skills. |

<br />

## Who it is for

- Candidates preparing for a specific role who want a plan tied to its requirements.
- People practicing technical, system design, behavioral, or HR interviews.
- Candidates who want to see *why* a readiness score changed after an answer.
- Developers who want to run a local app with Codex, Claude Code, opencode, or a deterministic mock runtime.

<br />

## How it works

```text
Resume + job description
          ↓
Candidate profile + target requirements
          ↓
Gap analysis → preparation plan
          ↓
Practice or mock interview → answer evaluation
          ↓
Skill evidence → readiness update → revised plan
          └───────────────────────────────↺ retest weak skills
```

For example, a vague answer about cache invalidation becomes weak evidence for
that skill. The readiness score updates, an invalidation exercise moves up the
prep plan, and a later interview can probe the same weakness again. Every
exposed score carries the evidence ids behind it.

### Try the feedback loop

1. Start the app with the [quickstart](#quickstart) and open **Target Role**.
2. Load the bundled `backend-engineer` example and analyze the target. It
   highlights gaps in caching, distributed systems, and system design.
3. Start an interview and give a vague answer to a caching consistency
   question, such as “I'd put Redis in front of the database.”
4. Open **Readiness** to inspect the weak evidence, then **Prep Plan** to see
   the reprioritized practice action.
5. Start another interview to see how the question selection responds.

<br />

## Features

<table>
  <tr>
    <td width="33%" valign="top"><h3>🎯 Role-specific planning</h3>Resume and job-description analysis produces typed profiles, skill gaps, and a concrete prep plan.</td>
    <td width="33%" valign="top"><h3>📈 Evidence-backed readiness</h3>Answers, practice, self-checks, and resume claims feed an auditable skill graph with append-only snapshots and time decay.</td>
    <td width="33%" valign="top"><h3>🎤 Interview modes &amp; loops</h3>Six focused modes plus multi-round loops that carry weak skills into later rounds for deliberate retesting.</td>
  </tr>
  <tr>
    <td valign="top"><h3>🏢 Company profiles</h3>Google/Meta/Amazon/Microsoft-style loop shapes, emphasis boosts, and behavioral frameworks per target.</td>
    <td valign="top"><h3>📝 Resume coach</h3>Deterministic ATS check, guarded bullet rewrites, and role tailoring that never invents facts.</td>
    <td valign="top"><h3>✍️ Behavioral coaching</h3>STAR evaluation and an editable story bank help develop answers for behavioral and HR rounds.</td>
  </tr>
  <tr>
    <td valign="top"><h3>🧭 Focused practice</h3>Single-question practice sessions target prep actions. Demonstrated progress can complete an action.</td>
    <td valign="top"><h3>🗂️ Multiple targets</h3>Prepare for several roles with one candidate profile. Targets keep their own gaps, plans, and sessions.</td>
    <td valign="top"><h3>📄 Document input</h3>Upload PDF, DOCX, TXT, or Markdown resumes and job descriptions. Extraction runs in memory on the server.</td>
  </tr>
  <tr>
    <td valign="top"><h3>🧩 Skills &amp; plugins</h3>Every skill declares a manifest enforced by SkillHost; local read-only plugins load from <code>plugins/</code>.</td>
    <td valign="top"><h3>📊 History &amp; metrics</h3>Full session history with weak-answer filtering, per-skill readiness deltas, and progress metrics.</td>
    <td valign="top"><h3>⌘K Command palette</h3>Start any mode or loop, practice a skill, or switch targets from a fuzzy Ctrl/Cmd+K palette.</td>
  </tr>
  <tr>
    <td valign="top"><h3>⚡ Live progress</h3>Analysis, question generation, evaluation, and debrief stages stream updates to the UI.</td>
    <td valign="top"><h3>🔌 Runtime choice</h3>Use a local Codex, Claude Code, or opencode installation, or run the full flow with the mock runtime.</td>
    <td valign="top"><h3>🔒 Local-first</h3>State lives in a local SQLite database. No account, no cloud — your resumes and answers stay on your machine.</td>
  </tr>
</table>

Interview modes are `technical`, `coding`, `system_design`, `behavioral`,
`hiring_manager`, and `hr`, plus a `mixed` round. Optional company notes can
influence the behavioral themes and skill focus. The seven-dimension answer
evaluation feeds evidence back into readiness.

<details>
<summary><strong>Feature details</strong></summary>

- **Adaptive engine v3**: question selection multiplies role importance ×
  readiness gap × uncertainty × weakness boost × recency × novelty, adapts
  difficulty to level and demonstrated strength, and pulls in skills related
  to weaknesses seen in earlier rounds.
- **Time decay**: evidence weights halve at type-specific half-lives
  (interview answers 60 d, practice 45 d, self-reports 30 d, resume claims
  180 d).
- **Interview loops**: a loop defaults to the active target's company-profile
  `typicalLoop` and is editable in the loop builder. Each completed round
  stores a deterministic handoff (weak skills < 0.5, strong skills ≥ 0.75,
  observations) plus readiness before/after snapshots, then opens the next
  round. The last round ends with a `loop-debrief` — never a hire/no-hire
  verdict.
- **Company profiles**: built-in Generic, Google, Meta, Amazon, and Microsoft
  profiles (heuristics from commonly reported patterns, not official guides)
  auto-match from the company name. Optional careers-page notes are profiled
  into values, interview style, focus skills, and behavioral themes.
- **Resume coach**: `/resume` runs a deterministic ATS check (weighted
  0–100), AI bullet rewrites, and a role-tailoring pass. A no-invented-facts
  guard substitutes invented numbers with `[add metric]` placeholders and
  drops suggestions that introduce entities absent from the resume; nothing
  is auto-applied.
- **Practice &amp; self-checks**: practice answers produce `practice` evidence
  and auto-complete the action at a demonstrated score ≥ 0.7; ticking success
  criteria records one `self_report` evidence entry (confidence 0.5).
- **Plugins**: each plugin is a directory with `manifest.json` +
  `index.ts|js`, discovered in `INTERVIEW_OS_PLUGINS_DIR` (default
  `plugins/`). Plugins are read-only and receive only the state slices their
  manifest declares. Ships with `interview-day-checklist`.
- **Success metrics** (`/api/metrics`): loops completed, sessions per mode,
  weakness-retest rate, improvement after prep, prep completion rate,
  readiness coverage, and allowlisted usage counts (names only, no content).

</details>

## What's new in v0.3

- **Interview modes + full loops**: six focused modes and multi-round
  interview loops with deterministic round handoffs — a weak round-1 answer
  retests related skills in later rounds.
- **Company profiles**: Google/Meta/Amazon/Microsoft-style loop shapes,
  emphasis boosts, and behavioral frameworks, per target.
- **Resume coach**: deterministic ATS check, guarded bullet rewrites, and
  role tailoring — it never invents facts.
- **Skills & plugins**: every skill declares a manifest; `SkillHost` enforces
  input/output/permission boundaries; local read-only plugins load from
  `plugins/`.
- **History, metrics & command palette**: full session history with
  weak-answer filtering, progress metrics on Home, a Ctrl/Cmd+K palette, and
  usage events.

## Screenshots

| | |
|---|---|
| ![Home — progress metrics](docs/screenshots/home-progress.png) | ![Coding round evaluation](docs/screenshots/coding-eval.png) |
| ![Loop debrief with per-round deltas](docs/screenshots/loop-debrief.png) | ![Readiness evidence](docs/screenshots/readiness.png) |

<br />

## Quickstart

**Requirements:** Node.js 24 and [pnpm](https://pnpm.io) 12. The mock runtime
runs without an AI provider account or CLI.

```bash
git clone https://github.com/interview-ps/InterviewOS.git
cd InterviewOS
pnpm install
INTERVIEW_OS_RUNTIME=mock pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The web app runs on port
3000 and the API server on port 4100. Load the `backend-engineer` example on
**Target Role** to try the complete loop.

To use the default Codex runtime, install and sign in to the
[Codex CLI](https://github.com/openai/codex), then run `pnpm dev`. You can also
select Claude Code or opencode with `INTERVIEW_OS_RUNTIME`; each uses its own
local sign-in.

On Windows PowerShell, set the runtime before starting the app:

```powershell
$env:INTERVIEW_OS_RUNTIME="mock"; pnpm dev
```

If a Windows Application Control policy blocks `pnpm.exe`, use
`corepack pnpm dev`. See [Windows notes](#windows-notes) for testing details.

<br />

## AI runtimes

Every backend implements `AIRuntime`; provider-specific code lives in
`packages/runtime`.

| Runtime | `INTERVIEW_OS_RUNTIME` | How it runs | Session behavior |
| --- | --- | --- | --- |
| Codex (default) | `codex` | Local `codex app-server` or `codex exec` | App-server threads can resume across restarts. |
| Claude Code | `claude` | Local Agent SDK installation | One-shot session wrapper. |
| opencode | `opencode` | Local `opencode run --format json` | One-shot session wrapper. |
| Mock | `mock` | Deterministic in-process responses | In-memory. |

Codex tasks use a read-only workspace and decline approval requests. Prompts
containing resumes, job descriptions, and answers travel through stdin or SDK
payloads, never process arguments or shell strings. Child processes receive an
allowlisted environment. Provider authentication stays with the provider's
local installation.

<details>
<summary><strong>Runtime and server configuration</strong></summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `INTERVIEW_OS_RUNTIME` | `codex` | `codex`, `mock`, `claude`, or `opencode` |
| `INTERVIEW_OS_RUNTIME_FALLBACK` | — | Set to `mock` to fall back when the selected runtime is unavailable |
| `INTERVIEW_OS_CODEX_BIN` | `codex` on PATH | Codex executable path |
| `INTERVIEW_OS_CODEX_TIMEOUT_MS` | `120000` | Per-task timeout |
| `INTERVIEW_OS_CODEX_WORKSPACE` | `data/codex-workspace` | Read-only workspace |
| `INTERVIEW_OS_CLAUDE_BIN` | `claude` on PATH | Claude executable path |
| `INTERVIEW_OS_CLAUDE_TIMEOUT_MS` | `120000` | Per-task timeout |
| `INTERVIEW_OS_CLAUDE_WORKSPACE` | `data/claude-workspace` | Claude task workspace |
| `INTERVIEW_OS_OPENCODE_BIN` | `opencode` on PATH | opencode executable path |
| `INTERVIEW_OS_OPENCODE_TIMEOUT_MS` | `120000` | Per-task timeout |
| `INTERVIEW_OS_OPENCODE_WORKSPACE` | `data/opencode-workspace` | opencode task workspace |
| `INTERVIEW_OS_PLUGINS_DIR` | `<repo>/plugins` | Plugin discovery directory (manifest.json + index.ts per plugin) |
| `INTERVIEW_OS_PORT` | `4100` | API server port |
| `INTERVIEW_OS_DB` | `data/interview-os.db` | SQLite database path |
| `INTERVIEW_OS_MOCK_DELAY_MS` | `0` | Per-chunk delay for mock streamed deltas |
| `INTERVIEW_OS_TEST_MODE` | — | `1` enables `POST /api/test/reset` (e2e isolation only) |

</details>

<br />

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         Interview OS                         │
├──────────────────────────────────────────────────────────────┤
│ Next.js web app                 Hono API + SQLite store      │
├──────────────────────────────────────────────────────────────┤
│ Orchestrator → SkillHost → skills → core readiness model     │
│ Plugins: local, read-only, manifest-declared inputs          │
├──────────────────────────────────────────────────────────────┤
│ AIRuntime → Codex | Claude Code | opencode | Mock            │
└──────────────────────────────────────────────────────────────┘
```

| Path | Responsibility |
| --- | --- |
| `apps/web` | Next.js and Tailwind UI on port 3000 |
| `apps/server` | Hono API on port 4100, document extraction, SQLite ownership |
| `packages/core` | Zod state schemas, taxonomy, readiness, gaps, prioritization |
| `packages/skills` | Analysis, planning, interview, coaching, evaluation, debrief |
| `packages/orchestrator` | Workflow and persisted state |
| `packages/runtime` | Provider adapters and deterministic mock runtime |
| `packages/shared` | Logging, ids, and errors |
| `plugins` | Local read-only plugins discovered via `INTERVIEW_OS_PLUGINS_DIR` |
| `tests` | Integration tests, fake provider fixture, optional browser tests |

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the design and
[AGENTS.md](AGENTS.md) for the invariants contributors must preserve.

<details>
<summary><strong>Selected API routes</strong></summary>

| Route | Purpose |
| --- | --- |
| `POST /api/preparation/:id/complete` | Record a self-check as evidence |
| `GET /api/targets`, `POST /api/targets`, `POST /api/targets/:id/activate` | Manage target roles |
| `PATCH /api/targets/:id` | Switch a target's company profile |
| `POST /api/documents/extract` | Extract an uploaded resume or job description |
| `POST /api/interviews` | Start an interview (`mode`, `focusSkillId`, `actionId`) or practice session |
| `POST /api/interviews/:id/answer` | Submit an answer, optionally with a code response (≤ 50 KB) |
| `POST /api/loops`, `GET /api/loops/:id`, `POST /api/loops/:id/abandon` | Multi-round interview loops |
| `GET /api/companies` | Built-in company profiles |
| `GET /api/settings`, `PUT /api/settings` | Configure model, effort, and task mode |
| `GET /api/runtime/models` | List available Codex models |
| `GET /api/stories`, `POST /api/stories/generate` | Read or generate STAR stories |
| `PATCH /api/stories/:id`, `POST /api/stories/:id/coach` | Edit or coach a story |
| `POST /api/resume/review`, `GET /api/resume/reviews/latest` | Resume coach review |
| `GET /api/history`, `GET /api/history/:id` | Session history with rubric and readiness deltas |
| `GET /api/metrics` | Progress metrics for the Home card |
| `GET /api/skills`, `POST /api/plugins/:id/run` | Skill manifests and plugin execution |
| `POST /api/events` | Allowlisted usage counter (names only, no content) |

Long-running operations also accept `?stream=1` or
`Accept: text/event-stream` and emit `stage`, `delta`, `result`, and `error`
events.

</details>

<br />

## FAQ

**Can I try the product without installing an AI provider?**

Yes. `INTERVIEW_OS_RUNTIME=mock pnpm dev` runs the complete feedback loop with
deterministic responses.

**Where does Interview OS store my progress?**

The API server persists candidate state, sessions, and evidence in a local
SQLite database. Readiness snapshots are append-only, and scores retain links
to their supporting evidence.

**Can I prepare for more than one job?**

Yes. Targets share your candidate profile and evidence while keeping their
requirements, plans, and interviews separate.

**Which interview formats are supported?**

Six focused modes — technical, coding, system design, behavioral, hiring
manager, and HR — plus mixed rounds and multi-round loops that retest weak
skills. Behavioral and HR answers can receive STAR feedback.

<br />

## Development

```bash
pnpm dev             # API + web app
pnpm typecheck       # TypeScript checks across the workspace
pnpm test            # Unit, runtime, and integration tests
pnpm test:coverage   # Same suite, with a 70% line coverage minimum
pnpm test:e2e        # Optional Playwright tests on the mock runtime
```

`tests/integration/feedback-loop.test.ts` exercises the canonical product loop.
CI runs typechecking, the Vitest coverage gate, and the web build on pull
requests and pushes to `main`. CI does not run Playwright or live provider
tests. Coverage measures package source, the API server, and web library
modules; it does not measure Next.js UI components.

Live provider tests are opt-in through `INTERVIEW_OS_LIVE_CODEX=1`,
`INTERVIEW_OS_LIVE_CLAUDE=1`, or `INTERVIEW_OS_LIVE_OPENCODE=1` with the
corresponding `pnpm test:codex`, `pnpm test:claude`, or
`pnpm test:opencode` command. The live Codex browser suite uses
`INTERVIEW_OS_LIVE_CODEX=1 pnpm test:e2e:live`.

### Windows notes

The `VAR=value command` form in the examples uses POSIX shell syntax. In
PowerShell, set the variable first (`$env:INTERVIEW_OS_RUNTIME="mock"; pnpm dev`);
in cmd.exe use `set INTERVIEW_OS_RUNTIME=mock && pnpm dev`.
On hosts where Application Control blocks `pnpm.exe`, prefix commands with
`corepack`. A policy that blocks the test runner's native `rolldown` binding
requires running tests on an unlocked machine or in CI.

<br />

## Roadmap

- **Sandboxed code execution** for coding rounds — run the answer, not just
  review it.
- **Voice mode** — spoken interviews with transcription.
- **Plugin marketplace** — discoverable plugins plus scoped write permissions
  behind explicit grants.
- Resume re-upload with versioned claims, real company research, cover
  letters, LinkedIn optimization, job-search automation, offer comparison,
  salary negotiation, larger question banks, and collaboration.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the broader plan.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), then
read the architectural rules in [AGENTS.md](AGENTS.md). Bug reports and feature
requests belong in [GitHub Issues](https://github.com/interview-ps/InterviewOS/issues).

## Acknowledgements

Ideas were inspired by
[Paramchoudhary/ResumeSkills](https://github.com/Paramchoudhary/ResumeSkills)
and [jennifer88huang/interview-skills](https://github.com/jennifer88huang/interview-skills).
No code was copied; Interview OS is independently implemented.

## License

MIT — interview.ps. See [LICENSE](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=interview-ps%2Finterviewos&amp;type=date&amp;legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=interview-ps/interviewos&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=interview-ps/interviewos&amp;type=date&amp;legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=interview-ps/interviewos&amp;type=date&amp;legend=top-left" />
  </picture>
</a>

---

<p align="center"><sub>Local-first interview preparation, built around evidence and practice.</sub></p>
