<a id="readme-top"></a>

<div align="center">

<img src="docs/assets/readme/hero.svg" alt="Interview OS — interview preparation that learns from your answers" width="100%" />

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=20&pause=1200&color=3178C6&center=true&vCenter=true&width=620&lines=Weak+answers+get+retested;Codex+%C2%B7+Claude+Code+%C2%B7+opencode+%C2%B7+Devin" alt="Weak answers get retested · Codex, Claude Code, opencode, Devin" />

**A local-first, open-source workspace for turning a resume and job description into a targeted prep plan, realistic mock interviews, and an evidence-backed view of your readiness.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge)](LICENSE) [![CI](https://img.shields.io/github/actions/workflow/status/interview-ps/InterviewOS/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/interview-ps/InterviewOS/actions/workflows/ci.yml) [![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white&style=for-the-badge)](https://nodejs.org/) [![pnpm](https://img.shields.io/badge/pnpm-12-F69220?logo=pnpm&logoColor=white&style=for-the-badge)](https://pnpm.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white&style=for-the-badge)](https://www.typescriptlang.org/) [![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](CONTRIBUTING.md) [![GitHub stars](https://img.shields.io/github/stars/interview-ps/InterviewOS?style=for-the-badge&logo=github)](https://github.com/interview-ps/InterviewOS/stargazers) [![Last commit](https://img.shields.io/github/last-commit/interview-ps/InterviewOS?style=for-the-badge)](https://github.com/interview-ps/InterviewOS/commits/main) [![Open issues](https://img.shields.io/github/issues/interview-ps/InterviewOS?style=for-the-badge)](https://github.com/interview-ps/InterviewOS/issues) [![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/J3KxYCtPv)

**[Quickstart](#quickstart)**&nbsp;•&nbsp;**[How it works](#how-it-works)**&nbsp;•&nbsp;**[Features](#features)**<br/>**[Runtimes](#ai-runtimes-and-local-data)**&nbsp;•&nbsp;**[Architecture](#under-the-hood)**&nbsp;•&nbsp;**[Contributing](#contributing)**

<!-- Demo placeholder: add docs/assets/demo.gif, then uncomment the line below.
<img src="docs/assets/demo.gif" alt="Interview OS demo: weak answer → readiness drop → retest" width="720" />
-->

</div>

<p align="center"><img src="docs/assets/readme/stats.svg" alt="7 interview modes · 4 AI runtimes · 12 built-in skills · 0 API keys pasted" width="100%" /></p>

<p align="center"><img src="docs/assets/readme/divider.svg" width="100%" alt="" /></p>

## Why Interview OS

Most interview tools give you a question list. Interview OS connects the whole preparation cycle: it finds the skills a role needs, helps you practice them, evaluates your answers, and uses the results to decide what to work on next.

<img src="docs/assets/readme/steps.svg" width="100%" alt="01 Set a target: Add your resume and a job description, or load a bundled example. 02 Prepare and interview: Follow a prioritized plan, practice one skill, or run a focused round or full interview loop. 03 Improve: Review the evidence behind each readiness score. Weak answers move skills up the plan and can be retested in later rounds." />

### Interview OS is for you if

- You want preparation tied to a **specific role**, rather than a generic question bank.
- You want to see **why** a skill is marked strong or weak.
- You want technical, coding, system design, behavioral, hiring manager, and HR practice in one place.
- You want to track progress across interviews and revisit weaknesses deliberately.
- You prefer a local app with a deterministic mock mode for trying the workflow without an AI provider.

| | Typical question list | Interview OS |
| --- | --- | --- |
| Practice targets | Generic questions | Skills required by your target role |
| Scores | Unexplained or none | Derived from stored evidence you can inspect |
| Weak answers | Forgotten | Raise prep priority and get retested |
| Setup | — | Runs locally; mock mode needs no AI provider |

### How it works

<img src="docs/assets/readme/loop.svg" alt="Feedback loop: resume and job description, skill gaps, prep plan, mock interview, answer evaluation, readiness evidence; weak skills get retested" width="100%" />

<details>
<summary>View as a diagram</summary>

```mermaid
flowchart LR
    A["Resume + job description"] --> B["Skill gaps"]
    B --> C["Prioritized prep plan"]
    C --> D["Practice or mock interview"]
    D --> E["Answer evaluation"]
    E --> F["Evidence-backed readiness"]
    F --> G["Updated plan"]
    G --> H["Next interview"]
    F -.->|weak skills retested| D
```

</details>

For example, if you give a vague answer about cache invalidation, Interview OS records that answer as evidence for the relevant skill. Its readiness score and prep priority change, and a later interview can probe that weakness again. Scores are derived from evidence, with the supporting entries visible in the app. Older evidence loses weight over time.

<p align="center"><img src="docs/assets/readme/divider.svg" width="100%" alt="" /></p>

## Features

<table>
  <tr>
    <td width="50%" valign="top"><h4>🎯 Prep built around your target</h4><p>Analyze a resume against a job description, see the skill gaps, and get a plan ordered by role importance and current readiness. Keep multiple target roles for one candidate; each target has its own gaps and plan while sharing the candidate's evidence.</p></td>
    <td width="50%" valign="top"><h4>🧭 Readiness you can inspect</h4><p>Each skill's score is backed by interview answers, practice, self-checks, or resume claims. The Readiness view shows the evidence and history behind it instead of presenting an unexplained number.</p></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><h4>🎙️ Interviews with a purpose</h4><p>Run technical, coding, system design, behavioral, hiring manager, HR, or mixed sessions. Build a multi-round loop, carry observations between rounds, and get a debrief showing strengths, weaknesses, and readiness changes. Coding answers are reviewed as text; they are <b>not executed</b>.</p></td>
    <td width="50%" valign="top"><h4>🔁 Practice that responds to weakness</h4><p>Question selection considers the target role, readiness gaps, uncertainty, recent questions, and weaknesses from earlier rounds. Complete a prep action with a self-check or answer a practice question to add fresh evidence.</p></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><h4>📝 Help with your application materials</h4><p>Review your resume for ATS basics, get guarded bullet suggestions and role tailoring, and build a STAR story bank for behavioral interviews. Suggested rewrites are never applied automatically; check them before use.</p></td>
    <td width="50%" valign="top"><h4>🏢 Company-shaped loops</h4><p>Choose a generic profile or a built-in Google, Meta, Amazon, or Microsoft-style profile to shape the round sequence and emphasis. These profiles are <b>heuristics based on commonly reported patterns</b>, not official company interview guides.</p></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><h4>📊 One place to follow progress</h4><p>Browse interview history, answer feedback, per-skill readiness changes, prep actions, and progress metrics. Use the command palette with <code>Ctrl/Cmd+K</code> to jump to common actions.</p></td>
    <td width="50%" valign="top"><h4>🔌 Local runtimes and plugins</h4><p>Use a locally installed Codex CLI by default, choose Claude Code, opencode, or Devin, or use the deterministic mock runtime. Skills declare their inputs and permissions; plugins run in an isolated child process, see only the state slices you grant, and can only propose evidence — the orchestrator decides what gets written.</p></td>
  </tr>
</table>

**v0.4 platform additions:** a [plugin SDK](docs/plugins.md) (`pnpm interview-os create-skill` / `validate`), community [company](docs/company-packs.md) and [role](docs/role-packs.md) packs plus shareable [interview packs](docs/interview-packs.md), [MCP server context](docs/security.md) (`interview-os.mcp.json`, per-tool allowlists), voice answers with delivery hints, a per-skill question bank, and full state [export/import](docs/security.md). Security model: [docs/security.md](docs/security.md).

### Screenshots

<p align="center"><strong>Evidence-backed readiness</strong></p>

![Evidence-backed readiness](docs/screenshots/readiness.png)

<details>
<summary>More screenshots</summary>

**Home and progress**

![Home progress metrics](docs/screenshots/home-progress.png)

**Coding answer evaluation**

![Coding round evaluation](docs/screenshots/coding-eval.png)

**Multi-round debrief**

![Loop debrief](docs/screenshots/loop-debrief.png)

</details>

<p align="right"><a href="#readme-top">back to top</a></p>

<p align="center"><img src="docs/assets/readme/divider.svg" width="100%" alt="" /></p>

## Quickstart

**Requirements:** Node.js 24, [pnpm](https://pnpm.io/) 12, and Git. The default AI runtime also needs a locally installed and signed-in [Codex CLI](https://github.com/openai/codex). You can try the complete workflow without Codex using mock mode.

```sh
git clone https://github.com/interview-ps/InterviewOS.git
cd InterviewOS
pnpm install
INTERVIEW_OS_RUNTIME=mock pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). In dev, the Vite UI runs on port 3000 and proxies `/api` to the API on port 4100; `pnpm start` instead builds the SPA and serves UI + API together from port 4100. To use your local Codex installation instead, stop the mock server and run `pnpm dev`.

> [!TIP]
> On Windows PowerShell, start mock mode with `$env:INTERVIEW_OS_RUNTIME="mock"; pnpm dev`. If your machine blocks `pnpm.exe` under Application Control, use `corepack pnpm` for the commands above. For other Windows install failures — `corepack pnpm` not launching — see the [Windows setup notes](CONTRIBUTING.md#setup), which also cover the test-runner caveat.

### Try the feedback loop

1. Open **Target Role** and load the `backend-engineer` example.
2. Analyze it to see gaps in caching, distributed systems, and system design, then open the prep plan.
3. Start a technical interview. Give a vague caching answer, such as “I'd put Redis in front of the database.”
4. Open **Readiness** to inspect the weak evidence, then **Prepare** to see the updated priority.
5. Start another interview to see that weakness come back into focus.

The mock runtime makes this walkthrough repeatable without AI calls. For your own resume and role, use a configured AI runtime. Resume and job description inputs accept PDF, DOCX, TXT, and Markdown files up to 5 MB.

<p align="center"><img src="docs/assets/readme/divider.svg" width="100%" alt="" /></p>

## AI runtimes and local data

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/opencode-dark.svg" /><img src="docs/assets/logos/opencode.svg" width="32" height="32" alt="opencode" /></picture><br/><sub>opencode</sub></td>
    <td align="center" valign="top"><img src="docs/assets/logos/claude.svg" width="32" height="32" alt="Claude Code" /><br/><sub>Claude Code</sub></td>
    <td align="center" valign="top"><img src="docs/assets/logos/codex.svg" width="32" height="32" alt="Codex" /><br/><sub>Codex</sub></td>
    <td align="center" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/devin-dark.png" /><img src="docs/assets/logos/devin.png" width="32" height="32" alt="Devin" /></picture><br/><sub>Devin</sub></td>
  </tr>
</table>
</div>

| Runtime | Select with `INTERVIEW_OS_RUNTIME` | How to start |
| --- | --- | --- |
| Codex (default) | `codex` or unset | Install and sign in to the Codex CLI, then run `pnpm dev`. |
| Claude Code | `claude` | Sign in with the Claude Code CLI, then run `INTERVIEW_OS_RUNTIME=claude pnpm dev`. |
| opencode | `opencode` | Sign in with `opencode auth login`, then run `INTERVIEW_OS_RUNTIME=opencode pnpm dev`. |
| Devin | `devin` | Sign in with `devin auth login`, then run `INTERVIEW_OS_RUNTIME=devin pnpm dev`. |
| Mock | `mock` | Run `INTERVIEW_OS_RUNTIME=mock pnpm dev`; no AI provider required. |

Interview OS keeps application state in a local SQLite database (`data/interview-os.db` by default). When you select a real AI runtime, the content needed for analysis and interviewing is sent through that provider's local tooling. The app does not ask you to paste an API key into Interview OS. See [Architecture](ARCHITECTURE.md) for the runtime and data flow.

### Configuration

<details>
<summary><b>Configuration</b> — environment variables</summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `INTERVIEW_OS_RUNTIME` | `codex` | `codex`, `claude`, `opencode`, `devin`, or `mock`; overrides the runtime picked in Settings |
| `INTERVIEW_OS_RUNTIME_FALLBACK` | none | Set to `mock` to use mock mode if the selected runtime is unavailable |
| `INTERVIEW_OS_PORT` | `4100` | API server port |
| `INTERVIEW_OS_HOST` | `127.0.0.1` | Bind address for the API server (and the Vite dev/preview server). Set to a non-loopback host only on trusted networks — the API has no authentication |
| `INTERVIEW_OS_DB` | `data/interview-os.db` | SQLite database path |
| `INTERVIEW_OS_PLUGINS_DIR` | `<repo>/plugins` | Local plugin discovery directory |

Runtime model, reasoning effort, and task mode can be changed in **Settings**. For provider-specific paths, timeouts, and test settings, see [Architecture](ARCHITECTURE.md) and the runtime code in [`packages/runtime`](packages/runtime).

</details>

<p align="right"><a href="#readme-top">back to top</a></p>

<p align="center"><img src="docs/assets/readme/divider.svg" width="100%" alt="" /></p>

## Under the hood

<div align="center">

[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/) [![React Router](https://img.shields.io/badge/React_Router-CA4245?style=flat-square&logo=reactrouter&logoColor=white)](https://reactrouter.com/) [![Hono](https://img.shields.io/badge/Hono-E36002?style=flat-square&logo=hono&logoColor=white)](https://hono.dev/) [![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://www.sqlite.org/) [![Zod](https://img.shields.io/badge/Zod-3E67B1?style=flat-square&logo=zod&logoColor=white)](https://zod.dev/) [![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/) [![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/) [![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev/)

</div>

<img src="docs/assets/readme/architecture.svg" width="100%" alt="Architecture: apps/web Vite + React Router interface on port 3000, apps/server Hono API on port 4100 with local SQLite containing the orchestrator and skills, over packages/core schemas and packages/runtime provider adapters" />

<details>
<summary>Repository layout</summary>

```text
apps/web             Vite + React Router SPA (dev :3000, built SPA served by the API)
        ↓
apps/server          Hono API (port 4100) + local SQLite
                     src/orchestrator — Interview and preparation workflows
                     src/skills       — Analyzers, planner, interviewer, evaluator, coaches
        ↓
packages/core        Shared schemas, readiness, gaps, prioritization
packages/runtime     Codex, Claude Code, opencode, Devin, and mock adapters
```

</details>

AI-generated state is schema-validated before it is saved. Readiness scores come from stored evidence, and snapshots are appended so changes can be inspected later. The [architecture guide](ARCHITECTURE.md) explains the design in detail; [AGENTS.md](AGENTS.md) records the project's core invariants.

<p align="center"><img src="docs/assets/readme/divider.svg" width="100%" alt="" /></p>

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the invariants in [AGENTS.md](AGENTS.md).

### Development

<details>
<summary><b>Development commands</b></summary>

```sh
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:e2e
```

The integration test in `tests/integration/feedback-loop.test.ts` covers the product's central promise: a weak answer changes readiness and is retested. Live provider tests are opt-in. See [Contributing](CONTRIBUTING.md) for setup, testing, and how to add a skill, mode, plugin, or runtime.

</details>

### Roadmap

Planned work includes sandboxed execution for coding answers, voice interviews, and broader plugin support. See [the implementation plan](IMPLEMENTATION_PLAN.md) for the project plan; planned features are not part of the current app.

<p align="center"><img src="docs/assets/readme/divider.svg" width="100%" alt="" /></p>

## License

Interview OS is [MIT licensed](LICENSE).

<!-- Star History: re-enable once the repo has meaningful star growth.

## Star History

<a href="https://www.star-history.com/?repos=interview-ps%2Finterviewos&type=date&logscale=&releases=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=interview-ps/interviewos&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=interview-ps/interviewos&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=interview-ps/interviewos&type=date&legend=bottom-right" />
 </picture>
</a>
-->

<img src="docs/assets/readme/footer.svg" width="100%" alt="" />
