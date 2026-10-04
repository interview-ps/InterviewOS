# Plugin Development Guide

Plugins extend Interview OS with local code that can read *declared and granted*
state slices and optionally propose evidence. They run in an isolated child
process — never inside the server process.

## Layout

A plugin is a directory with a manifest and an entry file:

```
my-plugin/
  skill.yaml        # manifest (manifest.json also accepted)
  index.ts          # or index.js / index.mjs — the entry file
```

Bundled plugins live in `plugins/`; installed ones go to `data/plugins/`.
`INTERVIEW_OS_PLUGINS_DIR` overrides the bundled-plugin directory.

## SDK

`@interview-os/plugin-sdk` (in `packages/plugin-sdk`) exports:

- `defineSkill(def)` — marks the entry file's default export as a skill. `def`
  is `{ id, name?, version?, permissions, capabilities?, inputs?, execute(ctx) }`.
- `loadManifestFile(dir)` / `findEntryFile(dir)` — manifest + entry resolution.
- `runPluginWithMock` (from `@interview-os/plugin-sdk/testing`) — executes a
  plugin in-process against a `MockRuntime` for tests.

The entry file's default export must be a `defineSkill` result. `execute`
receives a `PluginContext`: `{ input, request?, runtime?, log }`.

## Manifest fields (`skill.yaml`)

| field | notes |
|---|---|
| `id` | slug: `^[a-z0-9][a-z0-9-]{0,63}$` |
| `name`, `description`, `author` | display metadata |
| `version` | semver-ish string (≤ 24 chars) |
| `permissions` | requested permissions (see below) |
| `capabilities` | discovery tags (see below) |
| `inputs` | `{key, permission}` pairs — the state slices the plugin wants |
| `outputs` | free-form string list describing what it emits |
| `engines` | e.g. `{"interview-os": ">=0.4.0"}` — checked at load; incompatible plugins load but cannot run |

`kind` is forced to `"plugin"` by the loader.

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
`company_pack`, `role_pack`, `tool`, `checklist`.

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

```sh
pnpm interview-os create-skill <name>   # scaffold skill.yaml + index.ts + index.test.ts
pnpm interview-os validate <dir>        # check manifest, entry file, exports
```

The CLI is `packages/plugin-sdk/bin/interview-os.mjs`.

## Testing

`runPluginWithMock` from `@interview-os/plugin-sdk/testing` runs a plugin
in-process with a deterministic `MockRuntime` — the same deterministic handlers
the server tests use. Scaffolded plugins include `index.test.ts` showing the
pattern.

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

Each run spawns a Node child process with `--permission`:

- Filesystem access limited to the plugin's own directory (and the runner).
- No environment inheritance (the runner sees an empty env, except the
  `SystemRoot` variable Node itself requires to start on Windows).
- `net`/`http`/`https`/`dns`/`tls`/`child_process`/`worker_threads`/`cluster`/
  `module`/`wasi`/`repl` blocked via a module-resolve hook; `fetch`,
  `WebSocket`, `process.binding`/`dlopen` removed or stubbed.
- Output capped, run time-boxed, stderr truncated in logs.

**Honest caveat (Node 24):** network isolation is enforced by blocking modules
and globals, not by an OS-level sandbox or container. Treat plugins as
*untrusted-ish*: the isolation is a strong speed bump, not a security boundary
equivalent to a VM. Only install plugins you have reason to trust.

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
`readiness.panels`, `resume.tabs`, `settings.sections`. Icons: `database`,
`cloud`, `code`, `book`, `chart`, `puzzle`, `shield`, `star`.

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

Write `ui/src/index.tsx`, then bundle it:

```sh
pnpm interview-os build-ui <pluginDir>   # → ui/index.js (ESM; react/@interview-os/ui external)
```

`ui/index.js` must default-export the frame module:

```ts
export default {
  components: { "skill-tree": ({ sdk }) => <SkillTree sdk={sdk} /> },
  pages:      { "/": ({ sdk }) => <Home sdk={sdk} /> },
} satisfies PluginFrameModule;   // types from @interview-os/plugin-sdk
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
navigation — only the postMessage SDK. Design-system components
(`Card`, `SkillScore`, `Tabs`, `Button`, `Badge`, `EmptyState`, …) and theme
tokens are available via `@interview-os/ui` imports (served from the host's
runtime bundle through the import map).

## Plugin API v1 — typed hooks

`PLUGIN_API_VERSION = "1.0.0"` (`packages/core/src/platform/plugin-api.ts`).
Every capability is backed by a **hook** — a typed request/response contract in
the `PLUGIN_HOOKS` registry. The host validates the request before invoking and
the response after; an invalid response is a `PLUGIN_OUTPUT` error for that
hook only (callers fail soft where they already did).

| Hook | Capability | Request → Response |
| --- | --- | --- |
| `questions.suggest` | `question_source` | `{ skillId, roundType, level, count }` → `{ questions }` |
| `resources.suggest` | `resources` | `{ skillIds }` → `{ resources }` (host fills `skillId`/`source`) |
| `ui.render` | `ui` | `{ slot?, component, page?, params? }` → `{ ui }` |
| `ui.frameRun` | `ui` | `{ component?, page?, request }` → `{ output, ui? }` |
| `evaluation.review` | `evaluation` | `{ question, answer|null, evaluation }` → `{ observations ≤5, evidenceProposals? }` |
| `preparation.suggest` | `preparation` | `{ gaps ≤10, skillIds }` → `{ activities ≤10 }` |
| `events.sessionCompleted` | manifest `events` | `{ sessionId, roundType, scores }` → `{ evidenceProposals? }` |
| `events.readinessUpdated` | manifest `events` | `{ changedSkillIds }` → `{ evidenceProposals? }` |

**Versioning**: `engines["plugin-api"]` is a semver range checked like
`engines["interview-os"]`; missing means `^1.0.0`. Additive contract changes
bump minor, breaking changes bump major; the host supports the current major.

**Handlers style (preferred)**:

```ts
export default defineSkill({
  id: "my-plugin",
  permissions: ["readiness.read"],
  capabilities: ["question_source"],
  handlers: {
    "questions.suggest": async (req, ctx) => ({ questions: [/* … */] }),
  },
});
```

`ctx` gives `input`, `settings`, `storage`, `runtime` (with `runtime.invoke`),
and `log`. Legacy `execute(ctx)` still works — it receives
`request.kind`-style objects (`LEGACY_HOOK_KIND` maps hooks back to the old
`"questions"`/`"resources"`/`"ui"`/`"ui-frame"` kinds).

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

## Backend bundling and the contract kit

```sh
interview-os build <dir>      # esbuild index.ts+deps → dist/index.js (ESM; SDK external)
interview-os validate <dir>   # manifest + capability↔hook + contract tests
interview-os schema           # JSON Schema for skill.yaml (editors)
interview-os build-ui <dir>   # ui/src/index.tsx → ui/index.js
```

The loader prefers `dist/index.js` when present, so plugins can use npm
dependencies. `runContractTests({ dir })`
(`@interview-os/plugin-sdk/testing`) loads the manifest, checks
capability↔hook coverage, invokes each declared hook with built-in fixtures
(overridable via `opts.fixtures`), and validates responses against the hook
schemas. `packages/plugin-sdk/schema/skill.schema.json` is generated by
`scripts/gen-schema.ts` (`z.toJSONSchema`) and kept current by a test.

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
