# Security Guidelines

Interview OS is local-first: all state is a SQLite file under `data/`, and the
HTTP API binds to localhost. The trust surfaces are plugin code, pack content,
MCP servers, and import bundles.

## Threat model

| Surface | Threat | Where it's handled |
|---|---|---|
| **Plugins** | Untrusted local code reading too much state, writing fake evidence, exfiltrating data, escaping to the OS | Manifest validation + write-permission rejection at load (`loadManifestFile`, server loader); user-granted permission filtering (`plugin-service.ts`); child-process executor with `node --permission` (`src/plugins/executor.ts`, `runner.mjs`) |
| **Packs** | Invented "facts" presented as sourced; malicious URLs; oversized content | Zod pack schemas (`packages/core/src/packs`); provenance refinement — a `sourced` item must cite a declared `sources[].id`; `https://`-only source/resource URLs; community items labelled unverified in UI and prompts |
| **MCP servers** | Configuring a shell command over HTTP; secret leakage to a spawned process | Servers defined **only** in local `interview-os.mcp.json` (never via HTTP); disabled by default; per-tool `allowedTools`; minimal child env — `envPassthrough` names only, values never returned by the API (`src/mcp/McpManager.ts`) |
| **Import bundles** | Corrupt/hostile state overwrite | `ExportBundleSchema` Zod validation + id-uniqueness + referential checks *before* any write; single transaction; `confirm: "replace"` required (`src/orchestrator/export-service.ts`, `routes/export.ts`) |

## Plugin isolation (what's enforced, honestly)

Each plugin run spawns `node --permission`:

- fs reads/writes limited to the plugin directory and the runner directory.
- Environment: nothing inherited (`SystemRoot` only, required for Node startup
  on Windows).
- Network and process modules blocked (`net`, `http`, `dns`, `tls`,
  `child_process`, `worker_threads`, `cluster`, `module`, `wasi`, `repl`);
  `fetch`/`WebSocket` removed; `process.binding`/`dlopen` stubbed.
- Inputs limited to declared **and** granted slices; `ctx.runtime` exists only
  with a granted `runtime.invoke`.
- Evidence is proposal-only: validated, confidence-capped at 0.6, stored as
  `type: "plugin"` with its source, written by the orchestrator only when
  `evidence.write` was granted.

**Node 24 caveat:** network blocking is module/global-level, not an OS or
container boundary. A sufficiently motivated plugin binary may find an escape.
Install only plugins you have reason to trust; review the permission panel.

## MCP rules

- `interview-os.mcp.json` lives at the repo root (or `INTERVIEW_OS_MCP_CONFIG`);
  it is gitignored — `interview-os.mcp.example.json` is the template.
- The API can list/enable servers and allow tools, but **cannot** create or
  edit server definitions — a browser cannot turn the API into a shell.
- Child processes get a minimal env (PATH/SystemRoot/HOME/etc.) plus only the
  declared `envPassthrough` variable *names* that are set. Values never appear
  in responses or logs.
- Tool args ≤ 4 KB, results truncated to 12 000 chars, 30 s timeout.
- Fetched context is stored as an `external_contexts` row and injected into the
  interviewer prompt fenced as untrusted reference data.

## Secrets and untrusted text

- Provider auth is the provider's own local install; tokens never pass through
  Interview OS.
- Resume/JD/answer/document text is never placed in argv or shell strings and
  is never logged (lengths only).
- Plugin output, pack text, and MCP context render as text in the UI — never
  `dangerouslySetInnerHTML`; external links are `https` only with
  `rel="noopener noreferrer"`.

## Plugin UI threat model (v0.4)

A plugin UI contribution is untrusted content *and* (for frames) untrusted
code. The design is **declarative-first**: Level 1 plugins can only emit a
schema-validated `UINode` tree — there is no way to inject HTML, CSS, script,
a URL, or an arbitrary prop into host DOM, and every button action maps to a
closed vocabulary executed by the host, not by the plugin.

**Frame (Level 2) enforcement** — layered, assuming the plugin code is hostile:

- **Iframe sandbox**: `sandbox="allow-scripts"` only — never
  `allow-same-origin`, `allow-top-navigation`, `allow-popups`,
  `allow-forms`, `allow-modals`. The document runs in an **opaque origin**:
  no access to the parent DOM, cookies, `localStorage`, or the app's origin.
- **CSP** on the frame document (`default-src 'none'`): scripts only from the
  plugin's own `ui/assets/` and the host runtime under a per-response nonce;
  `connect-src 'none'` (no fetch/XHR/WebSocket at all); `img-src data:`;
  `form-action 'none'`; `base-uri 'none'`; `frame-ancestors 'self'`; plus
  `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, CORP
  `same-origin`.
- **Bridge**: the parent accepts only `event.source === iframe.contentWindow`
  (origin must literally be `"null"`), a Zod-validated `{v:1,id,type,payload}`
  envelope, ≤ 64 KB, ≤ 20 msg/s. The only verbs are `ready`, `getData`,
  `run`, `action`, `resize`; replies go to that window alone.
- **Server-side gating**: `ui/data` returns only slices the plugin both
  declared and was granted (revoking `readiness.read` removes the slice);
  `ui/run` invokes the plugin in its isolated child with
  `request = {kind:"ui-frame",…}` and ignores evidence proposals; both require
  the component/page to be declared `kind:"frame"` on an enabled, compatible
  plugin. `ui/assets/` is realpath-confined to `<pluginDir>/ui/`, extension
  `.js/.css/.map` only, ≤ 2 MB.

**What plugin UI can never do**: touch the application DOM or its styles,
inject global CSS, load remote scripts or fonts, read cookies/storage, reach
`/api` or any network endpoint, open windows, submit forms, or navigate the
parent outside the bridge's re-validated `UIAction` vocabulary.

## Plugin API v1 additions

- **`answers.read`**: a new grantable read permission ("Interview Answers").
  `evaluation.review` hooks always see the question + built-in evaluation, but
  the answer text itself is `null` unless the user granted `answers.read`.
- **Plugin KV storage** (`plugin_storage`) is namespaced per plugin id, needs
  no permission (it is the plugin's own data), is unreachable from other
  plugins, capped at 256 KB, wiped on uninstall, and excluded from export.
- **Events run outside the orchestrator lock.** `sessionCompleted` /
  `readinessUpdated` hooks fire after the locked mutation resolves; their
  evidence proposals re-enter through the standard gate under the lock, and
  plugin-caused recomputes are tagged `plugin*` so `readinessUpdated` can
  never loop back into plugins.
- **Settings** (`plugin_settings`) are manifest-declared and validated
  key-by-key — a plugin cannot self-declare new config surface at runtime.
- **`evaluation.review` is observation-only by contract**: the built-in
  evaluation is never modified; evidence still requires `evidence.write` and
  stays proposal-only/capped. `preparation.suggest` is read-only; the user's
  "Add to plan" click is the consent for the write.
- **Runtime providers are trusted local code**, not sandboxed plugins: they
  run in-process with full network/process access and load only from the local
  `interview-os.runtimes.json` file (never HTTP, like `interview-os.mcp.json`).
  Treat them as you would the app's own dependencies — a malicious provider can
  do anything the server can. Plugin sandboxing does **not** apply to them.
