# Design: Python Plugin System (Octop model)

Status: **Draft / proposal** — part of the FastAPI backend migration.
Scope: the plugin system of the Python (FastAPI) backend.
Parent design: **[FastAPI Backend Refactor](./fastapi-backend-refactor.md)**
(integration points in its §12).

This design deliberately copies the plugin model of
[Octop](https://github.com/TencentCloud/Octop) and
[octop-harness](https://github.com/TencentCloud/octop-harness) (both MIT,
© 2026 Octop). Any code ported verbatim must keep the MIT notice in a
`THIRD_PARTY_NOTICES.md` entry and in the ported file headers.

> **Decision D1 (accepted): all plugins, bundled and third-party, load
> in-process**, as in Octop. This replaces several Interview OS invariants
> (isolated plugin process, granted state slices, enforced proposal-only
> evidence, sandboxed plugin UI). Section 12 lists every invariant that changes
> and the `AGENTS.md` edits that land with the cut-over.

---

## 1. Goals

- Python-first plugin authoring with the same ergonomics as Octop:
  `plugin.yaml` + `main.py` + `setup(ctx)`.
- Three plugin kinds — `tool`, `skill`, `hook` — exactly as in Octop.
- Optional prebuilt UI (`ui/dist`) that renders tool results in chat.
- Install from directory, ZIP or URL; bundled catalog ("market"); global
  enable/disable; CLI + Admin UI.
- Interview-mode plugins (today's `technical-mode`, `behavioral-mode`, …)
  keep working as `hook` plugins.

## 2. Source mapping (Octop → Interview OS)

| Octop / octop-harness | Interview OS (Python) |
|---|---|
| `octop_harness/plugins/manifest.py` (`PluginManifest`) | `interview_os/plugins/manifest.py` (Pydantic model) |
| `octop_harness/plugins/context.py` (`PluginContext`) | `interview_os/plugins/context.py` |
| `octop_harness/plugins/registry.py` (`PluginRegistry`, `*Registration`) | `interview_os/plugins/registry.py` |
| `octop_harness/plugins/loader.py` (`load_plugin_dir`, `load_all`, `unload_plugin`) | `interview_os/plugins/loader.py` |
| `octop_harness/plugins/tools.py` (`build_plugin_tools`, `get_tool_config`) | `interview_os/plugins/tools.py` |
| `octop/infra/agents/plugins/manager.py` (`PluginManager`) | `interview_os/plugins/manager.py` |
| `octop/infra/agents/plugins/bundled/` + `seed.py` | `plugins/` (repo) + `interview_os/plugins/seed.py` |
| `~/.octop/plugins/` | `data/plugins/` |
| `~/.octop/config.json` → `plugins.<id>.enabled` | `data/config.json` → `plugins.<id>.enabled` |
| Dashboard `GET /api/plugins/{id}/ui/…`, `setup(host)` | `apps/web` plugin loader, same contract |
| `octop_ui` result envelope | `ios_ui` result envelope |
| `octop plugin install/list` | `interview-os plugin install/list/...` |

## 3. Plugin layout

```
my-plugin/
├── plugin.yaml        # id, version, name, kind, entry; optional icon, group, ui, requires, modes
├── main.py            # must define setup(ctx)
├── requirements.txt   # optional, pip-installed on install (Octop behaviour)
├── skills/            # skill plugins only: <name>/SKILL.md
└── ui/                # optional prebuilt UI (no npm on install)
    └── dist/
        ├── index.js
        └── manifest.json
```

## 4. Manifest (`plugin.yaml`)

Copied from Octop's `PluginManifest` plus the manager-level fields Octop reads
directly from YAML (`icon`, `group`, `ui`). One Interview OS extension:
`modes` (declarative interview modes, see §7.4).

```yaml
id: demo-toolkit            # required, [a-z0-9-], unique; also the install dir name
version: 1.0.0              # required, dotted ints (compared as tuples for updates)
name: Demo Toolkit          # default: id
kind: tool                  # tool | skill | hook (default: tool)
entry: main.py              # default: main.py
description: ""
requires: []                # pip requirement strings
icon: "🧩"                  # emoji | http(s)/data:image URL | plugin-relative .svg/.png/...
group: tools                # catalog slug (see §8.3)
ui:                         # optional
  entry: ui/dist/index.js
  manifest: ui/dist/manifest.json
modes: []                   # Interview OS only; hook plugins (§7.4)
```

```python
PluginKind = Literal["tool", "skill", "hook"]

class PluginUI(BaseModel):
    entry: str = "ui/dist/index.js"
    manifest: str = "ui/dist/manifest.json"

class PluginManifest(BaseModel, frozen=True):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    version: str
    name: str = ""            # validator: falls back to id
    kind: PluginKind = "tool"
    entry: str = "main.py"
    description: str = ""
    requires: tuple[str, ...] = ()
    icon: str | None = None
    group: str | None = None
    ui: PluginUI | None = None
    modes: tuple[ModeSpec, ...] = ()   # ModeSpec lives in interview_os.core

    @classmethod
    def load(cls, path: Path) -> "PluginManifest": ...   # yaml.safe_load + validate
```

Validation rules copied from Octop: `id`/`version` required; unknown `kind`
rejected; `ui.entry`/`ui.manifest` must not contain `..`; missing UI entry file
→ plugin treated as backend-only (warning, not error); icon/group parsing is
lenient (invalid → `None`).

## 5. Plugin context (`setup(ctx)`)

Copied from `octop_harness/plugins/context.py`. Each registration method is
kind-checked and raises `ValueError` for the wrong kind.

| kind | API |
|---|---|
| `tool` | `ctx.tool(name, fn, description=..., config_fields=...)` |
| `skill` | `ctx.skills("skills")` — path relative to the plugin root |
| `hook` | `ctx.middleware(instance, priority=100)` — lower runs earlier |

```python
class PluginContext:
    plugin_id: str
    source_path: Path

    def tool(self, name: str, fn: Callable[..., Any], *, description: str = "",
             config_fields: list[dict[str, Any]] | None = None) -> None: ...
    def skills(self, relative_path: str) -> None: ...
    def middleware(self, instance: Any, *, priority: int = 100) -> None: ...

    # Model access (Octop: model_factory / get_model_access), bound after setup
    @property
    def runtime(self) -> AIRuntime | None: ...          # None during setup()
    def bind_runtime(self, runtime: AIRuntime) -> None: ...

    # Interview OS additions (read-only views; see §12 for the trust model)
    @property
    def state(self) -> StateReader: ...                  # typed accessors over InterviewOSState
    def evidence(self, proposal: EvidenceProposal) -> None: ...  # §7.5
    def to_loaded(self) -> LoadedPlugin: ...
```

Octop's `model_factory`/`get_model_access(spec)` maps to Interview OS's
`AIRuntime`: plugins call `ctx.runtime.run_task(prompt, schema)` and go through
`run_structured` so outputs are schema-validated like any skill.

## 6. Registry and loader

### 6.1 Registry (copied)

```python
@dataclass
class ToolRegistration:       plugin_id: str; name: str; fn: Callable; description: str; config_fields: list[dict]
@dataclass
class MiddlewareRegistration: plugin_id: str; instance: Any; priority: int = 100
@dataclass
class LoadedPlugin:
    manifest: PluginManifest; source_path: Path
    tools: list[ToolRegistration]; middleware: list[MiddlewareRegistration]
    skills_dir: Path | None; diagnostics: list[str]; context: PluginContext | None
```

`PluginRegistry` is a process-wide singleton (`register`, `unregister`, `get`,
`list_plugins`, `all_tools`, `build_middleware_chain(global_enabled=...)`,
`clear`, `reset`). `build_middleware_chain` skips globally-disabled plugins and
sorts by `priority`.

### 6.2 Loader (copied)

`load_plugin_dir(plugin_dir, *, install_deps=True) -> LoadedPlugin`:

1. `PluginManifest.load(plugin_dir / "plugin.yaml")`.
2. Entry must exist.
3. If `install_deps` and (`requires` or `requirements.txt`): run
   `[sys.executable, "-m", "pip", "install", ...]` (argv array, captured output).
4. `importlib.util.spec_from_file_location("ios_plugin_<id>", entry,
   submodule_search_locations=[plugin_dir])`, register in `sys.modules`,
   `exec_module`; on failure remove from `sys.modules`.
5. Module must define callable `setup`; call `setup(ctx)`.
6. `register_loaded(ctx)` → registry.

`load_all(root)` loads every `*/plugin.yaml` dir, logging (not raising) per
plugin failures. `unload_plugin(id)` unregisters and drops
`ios_plugin_<id>` and its submodules from `sys.modules`.

## 7. Kinds in Interview OS

### 7.1 `tool`

Tools are plain Python callables (sync or async). Unlike Octop (LangChain
`StructuredTool` bound to an agent), Interview OS runtimes are external agent
CLIs (Codex, Claude Code, opencode, Devin).

**Decision D4: at cut-over, tools are invoked only by the orchestrator and
the UI**, via `POST /api/plugins/{id}/tools/{name}` (§9) and an internal
`PluginManager.invoke_tool(id, name, args)` that skills and services may call
explicitly. The AI runtime cannot call plugin tools. Reasons: none of the nine
bundled plugins is a tool plugin, and under D1 tools run with full access, so
model-initiated calls while the model reads untrusted resumes/JDs would be a
prompt-injection path. Tool argument schemas come from the function signature
(Pydantic `validate_call`).

**Future (not in scope): runtime access via a backend-hosted MCP server.**
When there is a real consumer, the backend may expose enabled tools as an MCP
server (`interview-os-plugins`), registered by each `ai/` adapter for a single
task or session and torn down afterwards. This is allowed only with all three
guardrails:
1. **Per-skill allowlist.** A skill manifest lists the plugin tools it may
   expose. The resume and JD analyzers (untrusted-document readers) never get
   tools.
2. **Per-tool enablement** (below) must be explicitly on for runtime exposure.
   The "on by default" rule applies only to orchestrator/UI invocation.
3. **Lengths-only logging** of tool arguments/results and a per-task call cap.
Per-provider support for per-session MCP registration (Codex `mcp_servers`,
Claude Agent SDK in-process MCP servers, opencode/Devin config) must be
verified before this is designed in detail.

Enablement copies Octop's `_tool_enabled`: off when the plugin is globally
disabled; otherwise **on by default**, with per-scope opt-out
`plugins.<id>.tools.<name>.enabled: false`. Per-tool config
(`config_fields`) is stored at `plugins.<id>.tools.<name>.config` and read
inside a tool with `get_tool_config(name)` (contextvar set per invocation,
replacing Octop's `RunnableConfig.configurable`).

Return value: prefer the UI envelope (§10), else any JSON-serialisable value.

### 7.2 `skill`

`ctx.skills("skills")` registers `skills/<name>/SKILL.md` folders. On runtime
start (`sync_skills_to_workspace`, copied) the manager copies each skill into
the provider workspace (`data/<provider>-workspace/skills/<name>/`), skipping
names that already exist. Agent CLIs that support skills (Claude Code, Codex,
Devin) pick them up natively.

### 7.3 `hook`

`ctx.middleware(instance, priority=...)`. Octop middleware wraps model calls
(`before_model` / `after_model`). Interview OS defines the middleware protocol
in `interview_os.core.plugins` — every method optional:

```python
class InterviewMiddleware(Protocol):
    # Octop-equivalent model-call hooks (wrap every AIRuntime call)
    async def before_model(self, call: ModelCall) -> ModelCall | None: ...
    async def after_model(self, call: ModelCall, result: ModelResult) -> ModelResult | None: ...

    # Interview OS lifecycle hooks (same names/payloads as today's PLUGIN_HOOKS)
    async def questions_suggest(self, req: QuestionsSuggestReq) -> QuestionsSuggestRes | None: ...
    async def resources_suggest(self, req) -> ...: ...
    async def preparation_suggest(self, req) -> ...: ...
    async def evaluation_review(self, req) -> ...: ...
    async def on_answer_evaluated(self, evt) -> EventRes | None: ...
    async def on_session_completed(self, evt) -> EventRes | None: ...
    async def on_readiness_updated(self, evt) -> EventRes | None: ...
    async def on_loop_completed(self, evt) -> EventRes | None: ...
    async def on_target_changed(self, evt) -> EventRes | None: ...
```

`AIRuntime` is wrapped by `MiddlewareRuntime(inner, chain)` built from
`registry.build_middleware_chain(global_enabled=...)`. Lifecycle hooks are
dispatched by the orchestrator in priority order; request/response models are
the Pydantic port of `PLUGIN_HOOKS` in `packages/core/src/platform/plugin-api.ts`.

### 7.4 Interview modes (Interview OS extension)

Today's mode plugins become `hook` plugins: the manifest keeps its declarative
`modes:` block (rubric, scope, follow-up rules — unchanged schema), and the
middleware implements the mode hooks:

```python
    async def mode_prepare_turn(self, req) -> ...: ...
    async def mode_reduce(self, req) -> ...: ...
    async def mode_follow_up(self, req) -> ...: ...
    async def mode_mock(self, req) -> ...: ...
```

### 7.5 Evidence

Plugins write evidence only through `ctx.evidence(EvidenceProposal)` or by
returning `evidenceProposals` from a hook. The host validates, caps confidence,
stores type `plugin` with `source=<plugin id>`, then recomputes readiness —
same rules as today (§12 explains why this is now advisory, not enforced).

`ctx.evidence(...)` never writes inline. It enqueues onto the orchestrator's
serialized plugin event queue, which persists proposals in a separate
`readiness` lock scope. Mode hooks run inside a `session:<id>` scope, so
writing inline would re-enter the lock manager and raise `LockOrderError`. See
the refactor design §8.1, rule 7. `ctx` exposes no other mutating orchestrator
API.

## 8. PluginManager

Copied from `octop/infra/agents/plugins/manager.py`;
`PluginManager(plugins_dir=data/plugins, config_path=data/config.json)`.

### 8.1 Enablement (config)

- `config.json` → `{"plugins": {"<id>": {"enabled": bool, "tools": {...}}}}`.
- Missing entry ⇒ **enabled** (Octop semantics). Bundled plugins are seeded
  with `enabled: false` (Octop `init` behaviour), so they stay off until the
  user enables them.
- Writes merge into existing JSON atomically; a corrupt `config.json` raises a
  typed error instead of being overwritten (Octop issue #730 fix).

### 8.2 Lifecycle

| Method | Behaviour |
|---|---|
| `seed_bundled()` | Copy missing bundled plugins into `data/plugins/` (globally off); upgrade installed bundled ones when the catalog version is newer. Uninstalled ids are remembered and **not** re-copied. |
| `load_installed(install_deps=True)` | Clear registry, load every enabled plugin, unload disabled ones. Called at startup. |
| `load_missing()` | Load on-disk plugins not yet in the registry (after CLI install while server runs). |
| `list_installed()` | id, version, name, kind, description, icon, group, requires, path, loaded, enabled, ui, tools (cached tool catalog so disabled plugins still list tools). |
| `set_enabled(id, bool)` | Persist, then load or unload. |
| `install_path(dir, force)` | Validate manifest, copy to `data/plugins/<id>` (`force` replaces), load with deps. |
| `install_archive(zip, force)` | ZIP magic check, zip-slip check per member, exactly one plugin root with `plugin.yaml`. |
| `install_url(url, force)` | http(s) only, GitHub `/blob/` → raw rewrite, download to temp, `install_archive`. |
| `uninstall(id)` | Unload, drop catalogs, delete dir, record id as uninstalled. |
| `resolve_ui_file(id, rel)` | Path-traversal-checked asset resolution under the plugin dir. |
| `sync_skills_to_workspace(ws)` | §7.2. |

### 8.3 Market

`list_market()` lists the bundled catalog (`plugins/` in the repo) with
`installed`, `installed_version`, `update_available`. `install_from_market(id)`
installs and enables. Groups (Interview OS slugs, unknown values pass through):
`modes`, `practice`, `resources`, `analytics`, `tools`, `ops`.

## 9. HTTP API (FastAPI)

| Method & path | Purpose |
|---|---|
| `GET /api/plugins` | `list_installed()` |
| `GET /api/plugins/market` | `list_market()` |
| `POST /api/plugins/market/{id}/install` | `install_from_market` |
| `POST /api/plugins/install` | body `{path}` \| `{url}` \| multipart ZIP; `force` flag |
| `PUT /api/plugins/{id}/enabled` | `{enabled: bool}` |
| `DELETE /api/plugins/{id}` | uninstall |
| `GET /api/plugins/{id}/tools` / `PUT …/tools/{name}` | list tools / set `enabled` + `config` |
| `POST /api/plugins/{id}/tools/{name}` | invoke a tool (returns envelope) |
| `GET /api/plugins/{id}/ui/{path:path}` | serve UI assets (`resolve_ui_file`) |
| `GET /api/plugins/market/{id}/ui/{path:path}` | market icons only |

## 10. UI

### 10.1 Result envelope

```json
{
  "ios_ui": { "renderer": "demo_card", "version": 1 },
  "data": { "title": "…", "count": 1 },
  "text": "plain fallback"
}
```

### 10.2 Frontend loading (copied from Octop Dashboard)

- When chat/interview opens, the web app fetches `GET /api/plugins`, and for
  each enabled plugin with `ui`, dynamic-imports
  `/api/plugins/{id}/ui/dist/index.js`.
- The module exports `setup(host)` and registers renderers:
  `host.registerRenderer("demo_card", Component)`.
- React is provided as `window.__IOS_REACT__` / `window.__IOS_JSX__`; plugins
  ship a self-contained ESM (React externalised), no npm on install.
- Rendering: a tool/hook result carrying `ios_ui.renderer` is rendered by the
  matching renderer; otherwise `text` is shown.
- Updates: **L1** — streaming output replaces the result via SSE;
  **L2** — interactive updates via `host.patchResult(resultId, patch)`.
- `ui/dist/manifest.json` lists renderers + versions; mismatched `version`
  falls back to `text`.

## 11. CLI

```
interview-os plugin install <dir|zip|url> [--force]
interview-os plugin list
interview-os plugin enable|disable <id>
interview-os plugin uninstall <id>
interview-os plugin validate <dir>      # load_plugin_dir(..., install_deps=False)
interview-os plugin pack <dir>          # ZIP with exactly one root (+ ui/dist)
interview-os plugin create <name> --kind tool|skill|hook [--ui]
```

Demo plugins (ported from Octop's demos, `plugins/demos/`):

| Directory | kind | Shows |
|---|---|---|
| `demo-toolkit` | tool | callable tools (time, text stats, configurable echo) |
| `demo-greeting-skill` | skill | sync a SKILL.md into the runtime workspace |
| `demo-turn-logger` | hook | middleware logging before/after model calls (lengths only) |
| `demo-ui-card` | tool + ui | tool returns `ios_ui` JSON; chat renders an interactive card |

## 12. Invariants that change (D1 accepted)

Octop runs plugins in the host process. Adopting that model means the
following `AGENTS.md` invariants are **replaced**, not merely relaxed:

| Current invariant (AGENTS.md #8 unless noted) | Under this design |
|---|---|
| Plugins run in an isolated child process (Node `--permission`, fs limited to plugin dir, no env, network/child-process blocked) | Plugins run **in-process** with the backend's full privileges (fs, network, env, DB). |
| Plugins receive only the state slices they declare *and* the user granted | Plugins *can* import anything; `ctx.state` is a convention, not a boundary. Permissions become **informational** (shown at install). |
| Only `evidence.write` allowed; proposal-only, validated, capped | Same API, but a plugin could bypass it and write the DB directly. |
| Plugin UI only via declarative slots or sandboxed opaque-origin iframes | Plugin ESM runs **same-origin** in the app with shared React. |
| No new dependency without review (Conventions) | `requires` / `requirements.txt` pip-installed into the backend env on install. |
| #6 untrusted documents never logged | Host still never logs them; plugin code is not constrained. |

Consequences: installing a plugin = trusting its author with every resume, JD,
answer and runtime credential reachable from the backend process. Required
`AGENTS.md` edits on adoption:

1. Rewrite invariant #8 to describe the in-process Octop model and the trust
   statement above.
2. Add: "Install only plugins you trust; install shows declared `requires`,
   `kind`, and source before confirmation."
3. Remove the plugin-isolation lines from `docs/security.md` and replace with
   the trust model.

Mitigations kept from Octop (cheap, retained regardless): globally-off
bundled plugins, zip-slip and path-traversal checks, ZIP magic check,
http(s)-only URL install, atomic config writes with corrupt-config protection,
`..`-free UI paths. Logging remains lengths-only in host code.

Optional future hardening (not in scope, kept compatible): an executor seam in
`load_plugin_dir` so a plugin can opt into an out-of-process runner without
changing the `setup(ctx)` API.

## 13. Migration from current TypeScript plugins

| Today | Python plugin |
|---|---|
| `skill.yaml` + `index.ts` + `defineSkill` | `plugin.yaml` + `main.py` + `setup(ctx)` |
| `capabilities: [interview_mode]`, `modes:` | `kind: hook`, `modes:` kept, middleware implements `mode_*` |
| `hooks: [questions.suggest, …]` | middleware methods (`questions_suggest`, …) |
| `permissions: [answers.read, evidence.write]` | informational in manifest (§12) |
| UI slots / sandboxed frame | `ui/dist/index.js` renderers + `ios_ui` envelope |
| `data/plugins/` | unchanged location |

The nine bundled plugins (`technical-mode`, `behavioral-mode`,
`hiring-manager-mode`, `hr-mode`, `system-design-mode`, `coding-mode`,
`interview-day-checklist`, `learning-resources`, `postgres-interviewer`) are
ported one by one; each port must keep its existing mock-runtime test
behaviour.

**Decision D5: all nine are ported to Python before cut-over.** There is no
Node plugin runner after cut-over and no TypeScript plugin compatibility layer.
- Declarative parts (`modes:` blocks, rubrics, scope, `prompts/`) move to
  `plugin.yaml` / the plugin dir unchanged.
- `@interview-os/plugin-sdk/mock-helpers` (concept coverage, STAR detection,
  generic templates) is ported to `interview_os.plugins.testing.mock_helpers`
  first, because every mode plugin's `mode.mock` depends on it.
- Ported plugin UIs (`coding-mode`, `system-design-mode`,
  `postgres-interviewer`) are rebuilt as `ui/dist` renderers (§10).
- Order: `technical-mode`, `hr-mode`, `behavioral-mode`,
  `hiring-manager-mode` (reducer + mock), then `learning-resources`,
  `interview-day-checklist`, then the UI-bearing `system-design-mode`,
  `coding-mode`, `postgres-interviewer`.
- Cut-over is blocked until all nine pass their ported tests and the
  feedback loop passes with them enabled.
- A **migration guide** (`docs/plugins-migration.md`, written in phase 7)
  maps `skill.yaml` → `plugin.yaml`, `defineSkill` → `setup(ctx)`, hooks →
  middleware methods, UI slots/frames → renderers. At first start, installed
  TS plugins in `data/plugins/` that lack `plugin.yaml` are listed as
  "incompatible — see migration guide" and are not loaded.

## 14. Testing

- Unit: manifest validation, kind checks in `PluginContext`, registry
  ordering, `_tool_enabled` matrix, config merge + corrupt-config error,
  zip-slip/path-traversal rejection, version-compare for updates.
- Loader: load/unload each demo; `sys.modules` cleanup on failure.
- Integration: feedback loop with all bundled mode plugins enabled on the mock
  runtime (Python port of `tests/integration/feedback-loop.test.ts`).
- E2E: install `demo-ui-card` ZIP via Admin, enable, invoke tool, card renders,
  `patchResult` updates it.
- Quick validity check (mirrors Octop README):

```bash
uv run python - <<'PY'
from pathlib import Path
from interview_os.plugins import PluginRegistry, load_plugin_dir
for name in ("demo-toolkit", "demo-greeting-skill", "demo-turn-logger", "demo-ui-card"):
    PluginRegistry.reset()
    p = load_plugin_dir(Path("plugins/demos") / name, install_deps=False)
    print(p.manifest.id, p.manifest.kind, len(p.tools))
PY
```

## 15. Open questions

1. ~~In-process loading for third-party plugins~~: **resolved (D1)**. All
   plugins load in-process. The install flow (CLI and Admin) must show the
   plugin source, `kind`, `requires`, and a trust warning ("runs with full
   access to your interview data") before confirming.
2. ~~Tool exposure to runtimes~~: **resolved (D4)**. At cut-over tools are
   orchestrator/UI-only. A backend-hosted MCP server is a guarded future option
   (§7.1).
3. ~~TS plugin support during migration~~: **resolved (D5)**. All nine are
   ported before cut-over, with no Node runner and a migration guide (§13).
