<p align="center">
  <img src="docs/assets/readme/hero.svg" alt="Interview OS — interview preparation that learns from your answers" width="600" />
</p>

<p align="center">
  <strong>A local-first, open-source workspace for turning a resume and job description into a targeted prep plan, realistic mock interviews, and an evidence-backed view of your readiness.</strong>
</p>

<p align="center">
  <a href="https://www.python.org/downloads/"><img alt="Python 3.13+" src="https://img.shields.io/badge/python-3.13%2B-blue?logo=python&logoColor=white" /></a>
  <a href="https://github.com/interview-ps/InterviewOS/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green" /></a>
  <a href="https://github.com/interview-ps/InterviewOS/releases"><img alt="Version" src="https://img.shields.io/badge/version-0.4.0-orange" /></a>
  <a href="https://github.com/interview-ps/InterviewOS/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/interview-ps/InterviewOS/ci.yml?branch=main&label=CI" /></a>
  <a href="https://fastapi.tiangolo.com/"><img alt="FastAPI" src="https://img.shields.io/badge/backend-FastAPI-009688?logo=fastapi&logoColor=white" /></a>
  <a href="https://ant.design/"><img alt="Ant Design" src="https://img.shields.io/badge/UI-Ant%20Design-1677ff?logo=antdesign&logoColor=white" /></a>
  <a href="https://github.com/interview-ps/InterviewOS"><img alt="GitHub stars" src="https://img.shields.io/github/stars/interview-ps/InterviewOS?style=social" /></a>
  <a href="https://discord.gg/J3KxYCtPv"><img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20Us-5865F2?logo=discord&logoColor=white" /></a>
</p>

<p align="center">
  <a href="#-highlights">Highlights</a> ·
  <a href="#-how-it-works">How it works</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-ai-runtimes">AI runtimes</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-contributing">Contributing</a>
</p>

---

**Interview OS** is a local-first interview-preparation workspace. Most tools hand you a question list; Interview OS connects the whole cycle — it finds the skills a role needs, helps you practice them, evaluates your answers, and uses the results to decide what to work on next. Every readiness score is backed by evidence you can inspect, and weak answers are deliberately retested in later rounds.

It runs on your machine, keeps its state in a local SQLite database, and never asks you to paste an API key — analysis and interviews go through a locally installed AI provider (Codex by default), or a deterministic mock runtime for trying the workflow end to end.

## ✨ Highlights

| | Feature | Description |
|---|---------|-------------|
| 🎯 | **Prep built around your target** | Analyze a resume against a job description, see the skill gaps, and get a plan ordered by role importance and current readiness. Multiple target roles share one candidate's evidence. |
| 🧭 | **Readiness you can inspect** | Each skill's score is backed by interview answers, practice, self-checks, or resume claims — with the evidence and history shown, not an unexplained number. |
| 🎙️ | **Interviews with a purpose** | Technical, coding, system design, behavioral, hiring-manager, HR, or mixed sessions; multi-round loops with cross-round handoff and a debrief. Coding answers are reviewed as text, **not executed**. |
| 🔁 | **Practice that responds to weakness** | Question selection weighs role, readiness gaps, uncertainty, recent questions, and earlier weaknesses. Weak skills rise up the plan and get retested. |
| 📝 | **Application-material help** | ATS review, guarded bullet suggestions, role tailoring, and a STAR story bank for behavioral interviews. Suggested rewrites are never applied automatically. |
| 🏢 | **Company-shaped loops** | Generic or built-in Google / Meta / Amazon / Microsoft-style profiles shape the round sequence — heuristics from commonly reported patterns, not official guides. |
| 📊 | **One place to follow progress** | Interview history, answer feedback, per-skill readiness change, prep actions, and metrics. `Ctrl/Cmd+K` opens the command palette. |
| 🔌 | **Local runtimes and plugins** | Codex, Claude Code, opencode, Devin, or the deterministic mock. Skills declare inputs and permissions; plugins run in-process, see only the slices you grant, and can only *propose* evidence. |

## 🔄 How it works

```
Resume + job description → skill gaps → prioritized prep plan → practice / mock interview
      → answer evaluation → evidence-backed readiness → updated plan → next interview
                              ↑ weak skills retested ─────┘
```

If you give a vague answer about cache invalidation, Interview OS records it as evidence for the relevant skill. Its readiness score and prep priority change, and a later interview can probe that weakness again. Older evidence loses weight over time.

## 🤔 Features

### Prepare & interview
- Target-role setup from a resume and job description (PDF, DOCX, TXT, Markdown up to 5 MB), or a bundled example such as `backend-engineer`.
- A prioritized prep plan with concrete actions and success criteria.
- Seven interview modes plus a multi-round **loop** with per-round deltas and a loop debrief.
- Practice a single skill, or run a full loop; question sources include company/role packs and your own question bank.

### Readiness & evidence
- Evidence-derived scores with confidence, history, and the source entries behind each one.
- Readiness snapshots are appended, so changes are inspectable over time.

### Runtimes & extensibility
- AI runtimes: **Codex** (default), **Claude Code**, **opencode**, **Devin**, and **mock**.
- **Plugins** (`plugin.yaml` + `main.py`): bundled interview modes and extensions; evidence proposals are schema-validated and confidence-capped before the orchestrator writes them.
- **Plugin UI**: host-rendered declarative trees plus sandboxed opaque-origin iframes.
- **MCP** context from local stdio servers only, with a per-tool allowlist.
- Community **company** / **role** packs and shareable **interview** packs; full state **export/import**.

Security model: [docs/security.md](docs/security.md). Plugin guide: [docs/plugins.md](docs/plugins.md).

## 🧠 AI runtimes

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/opencode-dark.svg" /><img src="docs/assets/logos/opencode.svg" width="40" height="40" alt="opencode" /></picture>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/assets/logos/claude.svg" width="40" height="40" alt="Claude Code" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/assets/logos/codex.svg" width="40" height="40" alt="Codex" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/devin-dark.png" /><img src="docs/assets/logos/devin.png" width="40" height="40" alt="Devin" /></picture>
</p>

| Runtime | Select with `INTERVIEW_OS_RUNTIME` | How to start |
| --- | --- | --- |
| Codex (default) | `codex` or unset | Install and sign in to the Codex CLI, then run `pnpm dev:api`. |
| Claude Code | `claude` | Sign in with the Claude Code CLI, then `INTERVIEW_OS_RUNTIME=claude pnpm dev:api`. |
| opencode | `opencode` | `opencode auth login`, then `INTERVIEW_OS_RUNTIME=opencode pnpm dev:api`. |
| Devin | `devin` | `devin auth login`, then `INTERVIEW_OS_RUNTIME=devin pnpm dev:api`. |
| Mock | `mock` | `INTERVIEW_OS_RUNTIME=mock pnpm dev:api` — no AI provider required. |

State lives in local SQLite (`data/interview-os.db` by default). With a real runtime, the content needed for analysis and interviewing is sent through that provider's local tooling. See [ARCHITECTURE.md](ARCHITECTURE.md) for the data flow.

## 🚀 Quick Start

**Prerequisites:** [uv](https://docs.astral.sh/uv/) (Python 3.13), Node.js 24, [pnpm](https://pnpm.io/) 12, and Git. The default runtime also needs a locally installed and signed-in [Codex CLI](https://github.com/openai/codex); mock mode needs nothing extra.

```sh
git clone https://github.com/interview-ps/InterviewOS.git
cd InterviewOS
uv sync --project apps/api            # backend (FastAPI) deps
pnpm install                          # web + ui deps
INTERVIEW_OS_RUNTIME=mock pnpm start  # build the SPA, serve UI + API on :4100
```

Open **http://localhost:4100**. `pnpm start` builds the SPA and serves UI + API from the FastAPI server. For hot-reload development, run two terminals — `INTERVIEW_OS_RUNTIME=mock pnpm dev:api` (API on `:4100`) and `pnpm dev` (Vite UI on `:3000`, proxying `/api`) — then open **http://localhost:3000**. Drop `INTERVIEW_OS_RUNTIME=mock` to use your local Codex install.

### Try the feedback loop

1. Open **Target Role** and load the `backend-engineer` example.
2. Analyze it to see gaps in caching, distributed systems, and system design, then open the prep plan.
3. Start a technical interview and give a vague caching answer, e.g. “I'd put Redis in front of the database.”
4. Open **Readiness** to inspect the weak evidence, then **Prepare** to see the updated priority.
5. Start another interview to see the weakness come back into focus.

The mock runtime makes this walkthrough repeatable with no AI calls.

## ⚙️ Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `INTERVIEW_OS_RUNTIME` | `codex` | `codex`, `claude`, `opencode`, `devin`, or `mock`; overrides the runtime picked in Settings |
| `INTERVIEW_OS_RUNTIME_FALLBACK` | none | Set to `mock` to fall back when the selected runtime is unavailable |
| `INTERVIEW_OS_PORT` | `4100` | API server port |
| `INTERVIEW_OS_HOST` | `127.0.0.1` | Bind address (API + Vite dev/preview). Only use a non-loopback host on trusted networks — the API has no authentication |
| `INTERVIEW_OS_DB` | `data/interview-os.db` | SQLite database path |
| `INTERVIEW_OS_PLUGINS_DIR` | `<repo>/plugins` | Local plugin discovery directory |

Model, reasoning effort, and task mode are set in **Settings**. Runtime code: [`apps/api/src/interview_os/ai`](apps/api/src/interview_os/ai).

## 🏗️ Architecture

```
apps/web             Vite + React + Ant Design SPA (dev :3000; built SPA served by the API)
        ↓
apps/api             FastAPI server (:4100) + local SQLite
  src/interview_os/core          Pydantic models, readiness, gaps, priority
  src/interview_os/ai            Codex / Claude Code / opencode / Devin / mock adapters
  src/interview_os/skills        Analyzers, planner, interviewer, evaluator, coaches
  src/interview_os/orchestrator  Interview & preparation workflows (services + facade)
  src/interview_os/plugins       In-process plugin host
  src/interview_os/api           Routers, SSE, error mapping, static serving
        ↓
packages/frontend-types   Generated model types + plugin-UI vocabulary (from apps/api/schema)
packages/ui               Design system + declarative UINode renderer + frame runtime
packages/plugin-ui        Curated, Ant-Design-free plugin UI contract
plugins/ · packs/         Bundled plugins and content packs
```

AI-generated state is schema-validated before it is saved; readiness comes from stored evidence, with snapshots appended. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design; [AGENTS.md](AGENTS.md) records the core invariants.

## 🛠️ Development

```sh
pnpm typecheck              # tsc for web / ui / frontend-types / plugin-ui
pnpm test                   # apps/api pytest (unit + runtime + integration)
pnpm test:contract          # Python HTTP contract suite (spawns FastAPI, mock runtime)
pnpm test:e2e               # Playwright e2e (mock runtime, 21 specs)
pnpm build                  # plugin-runtime bundle + production SPA
```

The integration test `apps/api/tests/integration/test_feedback_loop.py` covers the product's central promise: a weak answer changes readiness and is retested. Live provider tests are opt-in. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and how to add a skill, mode, plugin, or runtime.

## 🔒 Security & privacy

- **Local-first**: state lives in a local SQLite database; no account, no telemetry.
- **No pasted keys**: provider auth uses the provider's own local install (`codex login`, `claude`, `opencode auth login`, `devin auth login`).
- **Capability-gated plugins**: install requires explicit enable; plugins receive only declared + granted slices and can only propose evidence.
- **Local-file integrations**: MCP servers and runtime providers are configured only through local files, never over HTTP.
- **Untrusted content** (resumes, JDs, answers, documents) never enters process argv or shell strings, and is never logged.

See [docs/security.md](docs/security.md).

## 🤝 Contributing

Contributions are welcome:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Run `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` before opening a PR.
4. Open a Pull Request.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, and [AGENTS.md](AGENTS.md) for module boundaries and conventions.

## 🗺️ Roadmap

Planned work includes sandboxed execution for coding answers, voice interviews, and broader plugin support. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); planned features are not part of the current app.

## 📄 License

Interview OS is [MIT licensed](LICENSE).
