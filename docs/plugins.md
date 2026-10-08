# Plugin Development Guide

Plugins extend Interview OS with local code that can read *declared and granted*
state slices and optionally propose evidence. They run **in-process** in the
FastAPI backend (pure Octop model; see `docs/design/python-plugin-system.md`
§12) — trust is accepted up front, and the host keeps each plugin to only what
it declares.

## Layout

A plugin is a Python package directory with a manifest and an entry module:

```
my-plugin/
  plugin.yaml       # manifest
  main.py           # entry: defines setup(ctx)
```

Bundled plugins live in `plugins/`; installed ones go to `data/plugins/`.

## Authoring

`main.py` defines `setup(ctx)`, registering what the plugin contributes:

- `ctx.middleware(instance)` — a **hook** plugin's handler methods (the lifecycle
  hooks below, as snake_case methods such as `questions_suggest`).
- `ctx.tool(name, fn)` — a **tool** plugin's callable.
- `ctx.skills("skills")` — a **skill** plugin's skills directory.

`ctx` also exposes a read-only `state` view and an `evidence(proposal)` sink
(enqueue-only); `ctx.runtime` is bound only with a granted `runtime.invoke`. Hook
request/response shapes are the Pydantic models in
`apps/api/src/interview_os/core/plugin_api.py`; deterministic helpers shared by
the bundled mode plugins live in
`apps/api/src/interview_os/plugins/testing/mock_helpers.py`. Plugins are loaded
by `PluginManager` / `load_plugin_dir` and exercised by the tests under
`apps/api/tests/plugins/`.

The previous TypeScript SDK / `interview-os` CLI / `@interview-os/plugin-sdk`
(scaffold, `validate`, `test`, `build`, `build-ui`) is retired at the phase-8
cut-over: authoring a Python plugin is just `plugin.yaml` + `main.py` (plus
optional `prompts/` and `ui/`), and there is no build step.

## Manifest fields (`plugin.yaml`)

| field | notes |
|---|---|
| `id` | slug: `^[a-z0-9][a-z0-9-]{0,63}$` |
| `name`, `description`, `author` | display metadata |
| `version` | semver-ish string (≤ 24 chars) |
| `permissions` | requested permissions (see below) |
| `capabilities` | discovery tags (see below) |
| `inputs` | `{key, permission}` pairs — the state slices the plugin wants |
| `outputs` | free-form string list describing what it emits |
| `engines` | e.g. `{"interview-os": ">=0.4.0", "plugin-api": "^1.1.0"}` — checked at load; incompatible plugins load but cannot run |

`kind` is `tool`, `skill` or `hook` (the legacy `plugin` value is treated as a hook).

## Inputs and permissions

A plugin only ever receives an input slice that is **both** declared in
`inputs` **and** granted by the user at enable time.

| input key | permission |
|---|---|
| `candidate` | `candidate.read` |
| `target` | `target.read` |
| `readiness` | `readiness.read` |
| `gaps` | `readiness.read` |
| `stories` | `stories.read` |
| `recentEvaluations` | `interview.read` |
| `resume` | `resume.read` |
| `request` | `taxonomy.read` |

Other permissions a manifest may request: `taxonomy.read`, `runtime.invoke`
(grants `ctx.runtime.runTask`), and `evidence.write`.

**`evidence.write` is the only `*.write` a plugin may request.** Any other
`*.write` permission causes the plugin to be rejected at load. Denied
capabilities — local files outside the plugin dir, network, environment,
spawning processes — are enforced by isolation, not by permission grants.

## Capabilities

`interview`, `evaluation`, `question_source`, `preparation`, `resources`,
`company_pack`, `role_pack`, `tool`, `checklist`, `ui`, `interview_mode`.

Two capabilities are wired into the product:

- `question_source` — the interview flow calls enabled `question_source`
  plugins with `request = { kind: "questions", skillId, roundType, level, count }`.
  Return `{ questions: [{ skillId, text, difficulty?, expectedConcepts?, mode? }] }`.
  Candidates are validated against `QuestionCandidateSchema` and filtered to the
  requested skill/mode; a failing or empty source silently falls back to
  generated questions.
- `resources` — "Find more resources" on a prep action calls enabled
  `resources` plugins with `request = { kind: "resources", skillIds: [...] }`.
  Return `{ resources: [{ title, url?, summary?, kind }] }` where `kind` is
  `docs | explanation | practice | article | video` and `url` must be `https://`.

Other outputs render generically on the Skills page: `{items: [{title,
detail?}]}` renders as a checklist; anything else renders as JSON.

## Evidence proposals

Any run may return `evidenceProposals: [{skillId, score, confidence,
observation}]` alongside its main output:

- Proposal-only — plugins never write state directly.
- Schema-validated (`EvidenceProposalSchema`); invalid output → proposals
  rejected, run still returns its output.
- Confidence is capped at `0.6`; at most 20 proposals per run.
- Persisted as evidence `type: "plugin"` with `source: "plugin:<id>"` — only
  when the user granted `evidence.write`, and only by the orchestrator.

## CLI

The `interview-os` CLI is retired with the TypeScript SDK (phase-8 cut-over).
Authoring a Python plugin needs no build tooling; load it with
`POST /api/plugins/install { url: "<path>" }` or drop the directory under
`data/plugins/`.

## Testing

Plugin tests live in `apps/api/tests/plugins/`: they load the directory with
`load_plugin_dir` and invoke the middleware hook methods directly, against the
deterministic helpers in `apps/api/src/interview_os/plugins/testing/mock_helpers.py`.

## Install, enable, grant

- `POST /api/plugins/install { url }` accepts an `https://` git URL or a local
  path (shallow clone; no prompts, no credential helpers).
- Newly installed plugins start **disabled** with no permissions granted.
- `GET /api/plugins` returns each plugin's requested permissions and a
  `permissions` view (requested access vs. isolation-denied categories) for the
  review UI.
- `PUT /api/plugins/:id { enabled, grantedPermissions }` — granted permissions
  must be a subset of the manifest's requests; `evidence.write` is never
  auto-granted. A disabled plugin cannot run.
- `DELETE /api/plugins/:id` uninstalls git-installed plugins (bundled ones can
  only be disabled).
- `POST /api/plugins/:id/run` executes an enabled plugin; runs are time-boxed
  and output is size-capped.

## Isolation limits

Plugins run **in-process** in the FastAPI backend (the pure Octop model; trust is
accepted up front, `docs/design/python-plugin-system.md` §12). The host enforces
least privilege at the API boundary, not with an OS sandbox:

- A plugin receives only the input slices it declares in `inputs` **and** the user
  granted; `ctx.runtime` exists only with a granted `runtime.invoke`.
- Only `evidence.write` is an allowed `*.write`; anything else is rejected at load.
- Hook requests/responses are schema-validated; output is size-capped and runs are
  time-boxed.
- UI runs only through declared slots (declarative trees, or plugin components in a
  sandboxed opaque-origin iframe reached over the postMessage bridge).

**Honest caveat:** in-process plugins are *trusted local code* once loaded — only
install plugins you have reason to trust.

## Plugin UI (v0.4)

Plugins may add experiences through **declared** extension points only. Three
levels, all gated on capability `ui` + the plugin being enabled:

| Level | Manifest | What runs | Rendered by |
| ----- | -------- | --------- | ----------- |
| 1. Declarative slot/page | `kind: declarative` | isolated `execute` returns `{ ui: UINode }` | the host's `DeclarativeRenderer` |
| 2. Frame | `kind: frame`, `entry: ui/index.js` | your bundled React code in an opaque-origin iframe | you, inside the sandbox |
| 3. Page | `ui.pages[]` (either kind) | as above | `/plugins/<id>/<path>` |

```yaml
capabilities: [interview, ui]
ui:
  navigation:            # ≤ 2 — shell nav items → /plugins/<id><page>
    - { label: PostgreSQL, icon: database, page: "/" }
  commands:              # ≤ 5 — command palette entries
    - { id: start-pg, label: "Start PostgreSQL", action: { type: startInterview, modeId: pg-deep-dive } }
  slots:                 # ≤ 3 contributions per slot
    dashboard.cards:    [ { component: readiness-card, kind: declarative, title: "PG readiness" } ]
    readiness.panels:   [ { component: skill-tree, kind: frame, entry: ui/index.js } ]
  pages:                 # ≤ 5 — paths relative to /plugins/<id>
    - { path: "/", title: "PostgreSQL", kind: declarative, component: home }
interviewModes:          # ≤ 5 — session presets (POST /api/interviews pluginModeId)
  - { id: pg-deep-dive, label: "PG Deep Dive", roundType: technical,
      focusSkills: [sql.indexing], plannedQuestions: 4 }
taxonomy:                # extra skill nodes, registered at load
  - { id: sql.locking, label: Locking, keywords: [locks, deadlock] }
```

**Slots**: `dashboard.cards`, `dashboard.sidebar`, `target.tabs`,
`prepare.activities`, `interview.toolbar`, `interview.sidebar`,
`interview.question`, `readiness.panels`, `resume.tabs`, `settings.sections`.
Icons: `database`, `cloud`, `code`, `book`, `chart`, `puzzle`, `shield`, `star`.

The `interview.question` slot renders inside the live interview question card —
but only for contributions from the plugin that owns the session's mode, with
`params = { modeId, extra: question.extra }` (e.g. the coding problem panel).

### Declarative contributions

The server invokes `execute` with `request = { kind: "ui", slot, component,
page, params }`; return `{ ui: <UINode> }`. Node types: `stack`, `row`, `card`,
`heading`, `text`, `stat`, `badge`, `skillScore`, `progressList`, `list`,
`evidenceList`, `readinessChart`, `tabs`, `emptyState`, `divider`, `button`.
Limits: depth ≤ 8, ≤ 300 nodes, strings ≤ 500 chars, ≤ 64 KB serialized, no
html/style/className/url fields. `button.action` uses the closed vocabulary:
`navigate {to}` (app allowlist or your own `/plugins/<id>` paths),
`openPluginPage {path}`, `startInterview {roundType?, modeId?, plannedQuestions?}`,
`startPractice {skillId}`, `runPlugin {request ≤ 2 KB}` (stateless re-invoke —
the tree is replaced by the new `ui`).

### Frame contributions (Level 2)

Write `ui/src/index.tsx` and bundle it to `ui/index.js` with your own bundler
(there is no host build step). Keep `react`, `react-dom/client`,
`@interview-os/plugin-ui` and `@interview-os/ui` **external** — the host maps
them through the iframe import map to its runtime bundle, so the frame shares
the host's single React instance and design system.

`ui/index.js` must default-export the frame module:

```ts
export default {
  components: { "skill-tree": ({ sdk }) => <SkillTree sdk={sdk} /> },
  pages:      { "/": ({ sdk }) => <Home sdk={sdk} /> },
} satisfies PluginFrameModule;   // types from @interview-os/plugin-ui
```

Inside the iframe you get `sdk: PluginFrameSDK`:

```ts
sdk.ready()                     // → { pluginId, component|page, theme, params }
sdk.getData()                   // → your declared+granted slices, server-assembled
sdk.run(request)                // → isolated execute({request:{kind:"ui-frame",...}}) → { output, ui? }
sdk.action({ type: "startPractice", skillId })  // closed UIAction vocabulary
sdk.resize(height)              // ask the host to resize (clamped 80–1600 px)
```

The iframe is `sandbox="allow-scripts"` with an opaque origin and a CSP that
allows only the runtime bundle, your `ui/` assets, and `connect-src 'none'`:
no app DOM, cookies, storage, network, remote scripts, forms, popups, or top
navigation — only the postMessage SDK.

### The plugin UI contract (`@interview-os/plugin-ui`)

Import UI from **`@interview-os/plugin-ui`** — a small, curated, stable surface:
the declarative vocabulary/schema, `DeclarativeRenderer`, the frame SDK, and a
short component list (`Page`, `Section`, `Stack`, `Row`, `Card`, `Heading`,
`Text`, `Button`, `Tag`, `Alert`, `Empty`, `Spinner`, `Progress`, `Divider`,
`Stat`, `EvidenceList`, `QuestionCard`) plus theme tokens.

**Plugins must never import Ant Design.** Ant Design is the host app's component
engine and an implementation detail behind this contract; the plugin surface is
antd-free so a frame never bundles it and the API stays smaller than antd.
`@interview-os/ui` remains available (same components) for backward
compatibility; prefer `@interview-os/plugin-ui` in new plugins.

## Plugin API — typed hooks

`PLUGIN_API_VERSION = "1.1.0"` (`apps/api/src/interview_os/core/plugin_api.py`).
Every capability is backed by a **hook** — a typed request/response contract in
the `PLUGIN_HOOKS` registry. The host validates the request before invoking and
the response after; an invalid response is a `PLUGIN_OUTPUT` error for that
hook only (callers fail soft where they already did).

| Hook | Since | Capability | Request → Response |
| --- | --- | --- | --- |
| `questions.suggest` | 1.0.0 | `question_source` | `{ skillId, roundType, level, count }` → `{ questions }` |
| `resources.suggest` | 1.0.0 | `resources` | `{ skillIds }` → `{ resources }` (host fills `skillId`/`source`) |
| `ui.render` | 1.0.0 | `ui` | `{ slot?, component, page?, params? }` → `{ ui }` |
| `ui.frameRun` | 1.0.0 | `ui` | `{ component?, page?, request }` → `{ output, ui? }` |
| `mode.reduce` | 1.1.0 | `interview_mode` | `{ modeId, state, evaluation, question }` → `{ state }` |
| `mode.followUp` | 1.1.0 | `interview_mode` | `{ modeId, evaluation, state, depth, maxDepth }` → `FollowUpDecision` |
| `mode.prepareTurn` | 1.1.0 | `interview_mode` | `{ modeId, state, followUp }` → `{ turn }` (JSON ≤4KB; `{}` on failure) |
| `mode.mock` | 1.1.0 | `interview_mode` | `{ modeId, task: "interviewer"\|"evaluator", input }` → `{ output }` |
| `evaluation.review` | 1.0.0 | `evaluation` | `{ question, answer|null, evaluation }` → `{ observations ≤5, evidenceProposals? }` |
| `preparation.suggest` | 1.0.0 | `preparation` | `{ gaps ≤10, skillIds }` → `{ activities ≤10 }` |
| `events.sessionCompleted` | 1.0.0 | manifest `events` | `{ sessionId, roundType, scores }` → `{ evidenceProposals? }` |
| `events.readinessUpdated` | 1.0.0 | manifest `events` | `{ changedSkillIds }` → `{ evidenceProposals? }` |
| `events.answerEvaluated` | 1.1.0 | manifest `events` | `{ sessionId, questionId, skillId, roundType, rubric, scores }` — never answer text → `{ evidenceProposals? }` |
| `events.loopCompleted` | 1.1.0 | manifest `events` | `{ loopId, rounds: [{mode, sessionId}] }` → `{ evidenceProposals? }` |
| `events.targetChanged` | 1.1.0 | manifest `events` | `{ targetId, role, company? }` → `{ evidenceProposals? }` |

**Versioning**: `engines["plugin-api"]` is a semver range checked like
`engines["interview-os"]`; missing means `^1.0.0`. Additive contract changes
bump minor, breaking changes bump major; the host supports the current major.
Every hook, event, UI slot, permission and manifest feature carries a `since`
version; `GET /api/platform` returns the full catalogue (`apiVersion`, `hooks`,
`events`, `capabilities`, `permissions`, `uiSlots`, `answerFieldTypes`,
`manifestFeatures`) — derive from it, don't hardcode lists. When a manifest
declares a `plugin-api` floor below the `since` of a hook/feature it uses, the
loader and `interview-os validate` emit a **warning** (advisory, not a load
error).

**Hook handlers (preferred)**:

```python
class MyPlugin:
    async def questions_suggest(self, req):
        return QuestionsSuggestResponse(questions=[...])


def setup(ctx):
    ctx.middleware(MyPlugin())
```

`setup(ctx)` runs once at load; each hook method receives the validated request
model and returns the response model. A plugin may also implement a legacy
module- or instance-level `execute(input, request)` (used by
`POST /api/plugins/:id/run`); `LEGACY_HOOK_KIND` maps hooks back to the old
`"questions"`/`"resources"`/`"ui"`/`"ui-frame"` kinds.

**Capability ↔ hook rules (load time)**: every declared capability must be
backed by a hook it owns — via `handlers`, manifest `hooks`, or legacy
`execute` **with** manifest `hooks` (legacy `execute` without `hooks` = warning,
not error, for backward compat). `ui` additionally needs the `ui` manifest
section; `interview` needs `interviewModes` or `questions.suggest`;
`company_pack`/`role_pack` need `packs/companies|roles/` in the plugin dir
(and shipping those dirs without the capability is a load error). `tool` was
removed — MCP stays user-configured. `checklist` is a deprecated alias,
normalized to `preparation` at manifest parse.

**What the hooks do**: `evaluation.review` runs after the built-in evaluation
(parallel, 10 s/plugin timeout) on skills matching `appliesTo.skillPrefixes`;
`answer` is `null` unless `answers.read` was granted; observations surface as
`pluginReviews` on the answer + session page — the built-in evaluation is never
modified. `preparation.suggest` is read-only (`GET /api/preparation/suggestions`);
`POST .../suggestions/accept` re-validates the activity and inserts a prep
action with `source: "plugin:<id>"`. Plugin `interviewModes[].guidance`
(≤ 1500 chars) is rendered into interviewer/evaluator prompts as
`Plugin mode guidance (<plugin>, unverified): …`. Event hooks fire **outside
the orchestrator lock**, sequentially per plugin; evidenceProposals go through
the normal gate; `readinessUpdated` never re-fires for plugin-caused readiness
changes (recompute reasons tagged `plugin*`).

## Plugin interview modes (v1)

A plugin with the `interview_mode` capability may define whole interview
**modes** via the manifest `modes` section (≤5). The built-in `technical`,
`system_design`, `behavioral`, `hiring_manager`, `hr` and `coding` rounds are
themselves bundled mode plugins under `plugins/<name>-mode`; core keeps only
the legacy `mixed` round:

```yaml
capabilities: [interview_mode, ui]
permissions: [answers.read]          # only needed to see answer text/code
hooks: [mode.mock, ui.render]        # all mode.* hooks optional
modes:
  - id: coding                        # ^[a-z0-9][a-z0-9_-]{0,63}$; must not
                                      # collide with "mixed" or another mode
    label: Coding
    description: Solve a small algorithmic problem.
    scope:                            # inScope = (include empty || any include
      include: [coding]               #   subtree) && no exclude subtree
      exclude: []
    fallbackSkills: [coding]          # empty-pool fallback (default: each
                                      # include root + its children)
    answerFormat: text+code           # "text" (default), "text+code", "fields"
    answerFields:                     # ≤8 — required when format is "fields";
      - { key: choice, label: "Pick", type: choice, options: [a, b], required: true }
      - { key: why, label: "Why?", type: text }   # types: text|code|choice|number
    rubric:                           # 1–12 dimensions, exact-ids enforced
      - { id: correctness, label: Correctness }
    initialState: { problem: null, phase: briefing }
    reduce:                           # declarative default reducer
      copyExtra: [problem]            # question.extra keys copied into state
      set: { phase: working }         # constants set each turn
    context:                          # host-side context for the interviewer
      companyThemes: true             #   skill input — never sent to the plugin
      storyTitles: false
    followUp: rules                   # "generic" | "rules" | "never"
                                      # (default: rules if followUpRules, else
                                      # generic; "never" + followUpReason
                                      # disables chaining)
    followUpRules:                    # evaluated in order, respect maxDepth
      - { rubricId: correctness, below: 0.6, focus: correctness }
    interviewerPrompt: prompts/interviewer.md   # relative paths inside the
    evaluatorPrompt: prompts/evaluator.md       # plugin dir, ≤16KB each
```

- **Fully declarative is valid** — `mode.reduce`, `mode.followUp`,
  `mode.prepareTurn` and `mode.mock` hooks are optional overrides; their
  failure falls back to the declarative descriptor (`mode.prepareTurn` → `{}`).
- `mode.prepareTurn` runs before each interviewer call and returns a per-turn
  `turn` object passed to the interviewer as `modeTurn` (a string
  `turn.focusDimension` additionally feeds the `focusDimension` input) — use it
  for per-turn computed data like the system-design plugin's next uncovered
  dimension.
- `mode.mock` provides deterministic `MockRuntime` output for
  `interviewer.<mode>` / `answer-evaluator.<mode>` tasks. Evaluator mock input
  omits `answer`/`code`/`fields` unless `answers.read` was granted. Shared deterministic
  helpers (concept coverage, STAR detection, generic templates) live in
  `@interview-os/plugin-sdk/mock-helpers`.
- Registered modes appear in `GET /api/modes` and every mode picker; disabling
  the plugin hides the mode for new sessions (typed `VALIDATION` error) while
  stored sessions keep rendering (fallback label, read-only code).
- Prompt bodies are host-side material: paths must resolve inside the plugin
  directory (traversal rejected at manifest parse and at load).
- **`answerFormat: "fields"`**: the host renders the declared `answerFields`
  declaratively (no plugin code runs in the browser), validates submissions
  server-side (unknown keys, wrong types, missing required, non-option choices
  and overlong text/code are `VALIDATION` errors), persists them on the answer
  row, and passes them to the evaluator and to `evaluation.review`/`mode.mock`
  inputs — the last two only when `answers.read` was granted.
- **`modeSignals`** (v1.1): evaluators may emit an opaque
  `modeSignals: record` (≤ 8 KB JSON, else dropped with a warning) on the
  evaluation; it is persisted and handed back to `mode.reduce` as
  `evaluation.modeSignals`. The legacy top-level `designUpdates` still parses —
  system-design-mode reads `modeSignals.designUpdates` first and falls back to
  it — but new modes should use `modeSignals`. The persisted/wire shape stays an
  open record, but the AI-facing schema is closed to the signal keys the
  built-in modes use (a provider's strict structured-output schema cannot
  express a free-form object), so a new per-mode signal must be added to
  `ModeSignalsAi` in the answer-evaluator skill.
- **`problem`** (§9.1): the interviewer's mode artifact — a coding problem or a
  design brief — lands on the question's `extra` as an open `record | string |
  null`. The AI-facing schema is closed to the shape the bundled coding mode
  emits (`{title, statement, constraints[], examples[{input, output,
  explanation}]}`) or a plain string, because a provider's strict
  structured-output schema cannot express a free-form object; a new problem
  field must be added to `InterviewerProblem` in the interviewer skill.

## Settings and storage

Manifest `settings` (≤ 20 fields: `string|number|boolean|enum`) declares
per-plugin configuration. `GET/PUT /api/plugins/:id/settings` validates values
against the declaration (unknown keys rejected); the web app auto-renders the
form on `/skills` and under `/settings → Plugin settings`. Values reach every
run as `ctx.settings` — including frame `getData` (`data.settings`).

`ctx.storage.get/set/delete` is a per-plugin KV over IPC
(`plugin_storage` table): keys ≤ 128 chars, value ≤ 32 KB, ≤ 256 KB total.
It's the plugin's own data — no permission needed, not readable by other
plugins, wiped on uninstall, excluded from export.

## Shipping packs + taxonomy

`packs/companies/<id>/company.yaml` and `packs/roles/<id>/role.yaml` inside a
plugin dir load for **enabled** plugins (re-synced on enable/disable/uninstall),
tagged `source: "plugin:<id>"`. The matching `company_pack`/`role_pack`
capability is required; id collisions with existing packs are load errors for
that pack. `taxonomy` nodes register at load; `appliesTo.skillPrefixes`
limits `evaluation.review` to matching skills.

## Bundling

There is no build step: the host imports `main.py` directly (the TypeScript
esbuild SDK/CLI is retired at the phase-8 cut-over). Hook schemas are the Pydantic
models in `apps/api/src/interview_os/core/plugin_api.py`; the JSON Schema export in
`apps/api/schema/` is regenerated with
`uv run --project apps/api python -m interview_os.export_schema`.

## Runtime providers (trusted local code — not plugins)

AI runtimes need network/processes, so they are **not** sandboxed plugins.
`interview-os.runtimes.json` (repo root; `INTERVIEW_OS_RUNTIMES_CONFIG`
overrides; gitignored — commit `interview-os.runtimes.example.json` instead)
lists `{ kind, module }` entries; `module` is an absolute or config-relative
ESM path whose default export is:

```ts
{ kind: "my-runtime", label?, create(opts) => AIRuntime, healthCheck?(env, dir) }
```

`kind` must be a slug that doesn't collide with built-ins. Providers load at
startup (`loadRuntimeProviders`), appear in `GET /api/runtime/available` with
`trustedLocal: true` (shown as "trusted local provider" in Settings), and can
be selected via `PUT /api/runtime` like any kind. A bad module surfaces a load
error and never stops the server. Never configurable over HTTP — same trust
model as `interview-os.mcp.json`.
