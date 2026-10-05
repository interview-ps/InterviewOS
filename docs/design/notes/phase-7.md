# Phase 7 — plugin contract lock

Status: **in progress** — host + all 9 plugins ported (see the bottom section);
orchestrator/routes wiring, web screens, and snapshot re-record remain.
Sources of truth:
`docs/design/python-plugin-system.md` §4–§7, §9 and
`docs/design/fastapi-backend-refactor.md` §12. Deviations require editing this
file in the same change.

## 1. Manifest (`plugin.yaml`)

```yaml
id: demo-toolkit            # [a-z0-9-], unique, = install dir name
version: 1.0.0              # dotted ints, compared as tuples
name: Demo Toolkit          # default: id
kind: tool                  # tool | skill | hook  (default: tool)
entry: main.py              # default: main.py
description: ""
requires: []                # pip requirement strings (argv install, not shell)
icon: "🧩"                   # emoji | http(s)/data URL | plugin-relative svg/png
group: tools                # catalog slug
hooks: []                   # declared hook names (implied by middleware methods)
appliesTo: null             # PluginAppliesTo — skill-prefix scoping
settings: []                # PluginSettingField[] — per-plugin settings
taxonomy: []                # PluginTaxonomyNode[] — extra taxonomy nodes
interviewModes: []          # PluginInterviewMode[] — app-registered interview modes
ui:                         # rich declarative blocks AND/OR a prebuilt bundle
  entry: ui/dist/index.js
  manifest: ui/dist/manifest.json
  navigation: []            # legacy rich blocks are preserved 1:1
  commands: []
  slots: {}
  pages: []
modes: []                   # Interview OS extension (hook plugins)
```

Pydantic `PluginManifest(BaseModel, frozen=True)` in
`interview_os/plugins/manifest.py`; `id`/`version` required, unknown `kind`
rejected, `ui.entry`/`ui.manifest` must not contain `..`, missing UI entry →
backend-only (warning not error), icon/group lenient. `hooks`/`applies_to`/
`settings`/`taxonomy`/`interview_modes` reuse the existing core models
(`PluginAppliesTo`, `PluginSettingField`, `PluginTaxonomyNode`,
`PluginInterviewMode`) and the rich `ui` reuses `core.models.skills.PluginUI`
extended with the optional `entry`/`manifest` bundle paths. `interviewModes`
accepts the JSON key `interviewModes`.

## 2. `setup(ctx)` API (`interview_os/plugins/context.py`)

| kind | API |
|---|---|
| tool | `ctx.tool(name, fn, *, description="", config_fields=None)` |
| skill | `ctx.skills("skills")` (path relative to plugin root) |
| hook | `ctx.middleware(instance, *, priority=100)` (lower runs earlier) |

`PluginContext`: `plugin_id`, `source_path`; `runtime` (None during setup, bound
after), `bind_runtime(runtime)`; `state` (read-only `StateReader`);
`evidence(EvidenceProposal)` (enqueue only — never writes inline);
`to_loaded() -> LoadedPlugin`. Registration methods are kind-checked (raise
`ValueError` for the wrong kind).

## 3. Middleware / hooks (every method optional)

`interview_os/core/plugin_api.py` holds the request/response models
(`PLUGIN_HOOKS`). Middleware method names (snake_case of the hook):

- Model-call: `before_model(call)`, `after_model(call, result)` —
  `MiddlewareRuntime(inner, chain)` wraps every `AIRuntime` call.
- Lifecycle/request: `questions_suggest`, `resources_suggest`,
  `preparation_suggest`, `evaluation_review`, `on_answer_evaluated`,
  `on_session_completed`, `on_readiness_updated`, `on_loop_completed`,
  `on_target_changed`.
- Modes: `mode_prepare_turn`, `mode_reduce`, `mode_follow_up`, `mode_mock`.

Lifecycle hooks dispatch in priority order; request/response shapes are the
Pydantic port of `PLUGIN_HOOKS` (`packages/core/src/platform/plugin-api.ts`).

## 4. Registry / loader / manager

- `PluginRegistry` (process-wide singleton): `register`, `unregister`, `get`,
  `list_plugins`, `all_tools`, `build_middleware_chain(*, global_enabled)`,
  `clear`, `reset`.
- `load_plugin_dir(dir, *, install_deps=True)` → `LoadedPlugin`:
  manifest → entry exists → optional pip install (`requires`/requirements.txt,
  argv) → `spec_from_file_location("ios_plugin_<id>", entry,
  submodule_search_locations=[dir])`, `exec_module`, must define `setup`,
  call `setup(ctx)`, register. `load_all(root)` logs per-plugin failures;
  `unload_plugin(id)` drops `ios_plugin_<id>` and submodules from `sys.modules`.
- `PluginManager(plugins_dir=data/plugins, config_path=data/config.json)`:
  `seed_bundled`, `load_installed`, `load_missing`, `list_installed`,
  `set_enabled`, `install_path`, `install_archive`, `install_url`, `uninstall`,
  `resolve_ui_file`, `sync_skills_to_workspace`, `list_market`,
  `install_from_market`. Enablement: missing entry ⇒ enabled; bundled seeded
  `enabled: false`; atomic config writes; corrupt config → typed error.

## 5. HTTP (`/api/plugins`, plugin design §9)

`GET /api/plugins`, `GET /api/plugins/market`,
`POST /api/plugins/market/{id}/install`, `POST /api/plugins/install`,
`PUT /api/plugins/{id}/enabled`, `DELETE /api/plugins/{id}`,
`GET/PUT /api/plugins/{id}/tools[/{name}]`,
`POST /api/plugins/{id}/tools/{name}`,
`GET /api/plugins/{id}/ui/{path}`,
`GET /api/plugins/market/{id}/ui/{path}`.

`GET /api/modes` comes from hook plugins' declarative `modes:`.

**These routes change** from the pre-phase-7 plugin API; the affected contract
snapshots (`tests/contract/fixtures/test_plugins*`, `test_installs` plugin
cases) are re-recorded deliberately in the phase-7 commit.

## 6. UI

Result envelope `{"ios_ui": {"renderer","version"}, "data": …, "text": …}`.
Web dynamic-imports `/api/plugins/{id}/ui/dist/index.js`; the module exports
`setup(host)` and registers renderers; React via
`window.__IOS_REACT__`/`window.__IOS_JSX__`. Streaming L1 replaces the result
over SSE; L2 uses `host.patchResult(resultId, patch)`.

## 7. Named consumers (must not drift)

- the 9 bundled plugins: `technical-mode`, `behavioral-mode`,
  `hiring-manager-mode`, `hr-mode`, `system-design-mode`, `coding-mode`,
  `interview-day-checklist`, `learning-resources`, `postgres-interviewer`;
- the web plugin screens;
- the plugin routes above (contract suite).
