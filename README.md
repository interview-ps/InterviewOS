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
    <td width="33%" valign="top"><h3>🎤 Adaptive interviews</h3>Mock interviews deliberately retest weak skills and explain why each question was selected.</td>
  </tr>
  <tr>
    <td valign="top"><h3>🧭 Focused practice</h3>Single-question practice sessions target prep actions. Demonstrated progress can complete an action.</td>
    <td valign="top"><h3>🗂️ Multiple targets</h3>Prepare for several roles with one candidate profile. Targets keep their own gaps, plans, and sessions.</td>
    <td valign="top"><h3>✍️ Behavioral coaching</h3>STAR evaluation and an editable story bank help develop answers for behavioral and HR rounds.</td>
  </tr>
  <tr>
    <td valign="top"><h3>📄 Document input</h3>Upload PDF, DOCX, TXT, or Markdown resumes and job descriptions. Extraction runs in memory on the server.</td>
    <td valign="top"><h3>⚡ Live progress</h3>Analysis, question generation, evaluation, and debrief stages stream updates to the UI.</td>
    <td valign="top"><h3>🔌 Runtime choice</h3>Use a local Codex, Claude Code, or opencode installation, or run the full flow with the mock runtime.</td>
  </tr>
</table>

Interview rounds can be `mixed`, `technical`, `system_design`, `behavioral`, or
`hr`. Optional company notes can influence the behavioral themes and skill
focus. The seven-dimension answer evaluation feeds evidence back into readiness.

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
| `INTERVIEW_OS_PORT` | `4100` | API server port |
| `INTERVIEW_OS_DB` | `data/interview-os.db` | SQLite database path |
| `INTERVIEW_OS_MOCK_DELAY_MS` | `0` | Delay for streamed mock updates |

</details>

<br />

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         Interview OS                         │
├──────────────────────────────────────────────────────────────┤
│ Next.js web app                 Hono API + SQLite store       │
├──────────────────────────────────────────────────────────────┤
│ Orchestrator → skills → core candidate and readiness model   │
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
| `tests` | Integration tests, fake provider fixture, optional browser tests |

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the design and
[AGENTS.md](AGENTS.md) for the invariants contributors must preserve.

<details>
<summary><strong>Selected API routes</strong></summary>

| Route | Purpose |
| --- | --- |
| `POST /api/preparation/:id/complete` | Record a self-check as evidence |
| `GET /api/targets`, `POST /api/targets`, `POST /api/targets/:id/activate` | Manage target roles |
| `POST /api/documents/extract` | Extract an uploaded resume or job description |
| `POST /api/interviews` | Start an interview or focused practice session |
| `GET /api/settings`, `PUT /api/settings` | Configure model, effort, and task mode |
| `GET /api/runtime/models` | List available Codex models |
| `GET /api/stories`, `POST /api/stories/generate` | Read or generate STAR stories |
| `PATCH /api/stories/:id`, `POST /api/stories/:id/coach` | Edit or coach a story |

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

Mixed, technical, system design, behavioral, and HR rounds are available.
Behavioral and HR answers can receive STAR feedback.

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

The next planned areas include resume re-upload with versioned claims, voice
mode, company research, cover letters, LinkedIn optimization, job search and
offer support, larger question banks, and collaboration. See
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the broader plan.

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

---

<p align="center"><sub>Local-first interview preparation, built around evidence and practice.</sub></p>
