# Design: ACP AI Runtime (Agent Client Protocol)

Status: **Implemented and verified (Phases 3–4).** opencode + devin run on `AcpRuntime`;
claude + codex keep their legacy adapters (no local ACP agent). See §7–§9.
Scope: replace the per-provider AI runtimes (`ai/{codex,claude,opencode,devin}`) with a
single `ai/acp/` client that drives each provider as an ACP *agent* subprocess.
Parent design: [`fastapi-backend-refactor.md`](./fastapi-backend-refactor.md).
Binding conventions: `AGENTS.md`, `apps/api/AGENTS.md`.

> **Verdict: the `AIRuntime` contract does NOT change.** Every member maps onto ACP
> without adding/removing a field (table §2). Two mappings are lossy but stay inside
> existing fields (`developer_instructions`, `effort`) — see §2.1. No consumer listed in
> the brief breaks. If that assessment is wrong, Phase 3 stops and reports.

## 1. Today's flow (surveyed)

| provider | run_task | session turn | thread persistence |
|---|---|---|---|
| codex | `codex exec --json` (prompt on stdin, schema temp file) **or** ephemeral `thread/start`+`turn/start` on a warm `codex app-server` (JSON-RPC/stdio) | persistent `thread/start`; `turn/start`; notifications `item/agentMessage/delta`/`item/completed`/`turn/completed` | `runtime_sessions.thread_id` = codex thread id, resumed via `thread/resume` |
| claude | `claude_agent_sdk.query` with `output_format: json_schema` | one-shot wrapper: each turn = fresh query, local `uuid4` thread_id, **no server resume** | local `dict` only; thread_id survives restart as an opaque id |
| opencode | `opencode run --format json` (prompt on stdin, NDJSON out) | one-shot wrapper, fresh process per turn | local `dict` only |
| devin | `devin -p --prompt-file <file>` (prompt in a workspace temp file) | one-shot wrapper, fresh process per turn | local `dict` only |

All child processes already use argv arrays, allowlisted env (`*/child_env.py`), and
`spawn_command`/`run_cli` (asyncio subprocess, no shell). The codex app-server
(`codex/process.py`) is already a newline-delimited JSON-RPC client — the exact transport
ACP needs.

## 2. ACP method mapping

| `AIRuntime` | ACP |
|---|---|
| `health_check` | spawn `<cmd> acp` → `initialize` `{protocolVersion:1, clientCapabilities, clientInfo}` → `RuntimeStatus(available, version=result.agentInfo.version, executable, workspace)`. Unavailable → setup hint. |
| `create_session(input)` | `session/new` `{cwd: <data>/<kind>-workspace (absolute), mcpServers: []}` → `sessionId`. `RuntimeSession{id:"rts_…", thread_id: sessionId}`. |
| `resume_session(thread_id)` | `session/load` `{sessionId, cwd, mcpServers: []}` when `agentCapabilities.loadSession`; else a fresh `session/new` under the same documented fallback the one-shot wrappers use today. |
| `send_message(session_id, msg)` | `session/prompt` `{sessionId, prompt:[{type:"text",text}]}`; `session/update` `agent_message_chunk` → `delta(text)`; `stopReason` `end_turn`→`completed`, `cancelled`→error `TIMEOUT`, `refusal`/other→error `PROTOCOL` or `CRASHED`. `agent_thought_chunk`/`tool_call`/plan/usage updates are ignored for events. |
| `run_task(task)` | ephemeral: `session/new` + one `session/prompt`. ACP has no output-schema field → the JSON Schema is embedded in the prompt text; `run_structured` still validates and retries (invariant 2). Result = JSON parse of the concatenated agent message; session closed after. |
| `close_session` | `session/cancel` (notification) → `session/close` when `sessionCapabilities.close`, else drop the handle. |
| timeout / `dispose` | deadline → `session/cancel` then terminate the child and, on Windows, its whole process tree; `dispose` cancels all sessions then terminates. stderr always drained. |
| `list_models` | `session/new` → `configOptions` where `category == "model"` (`select`) → `ModelInfo` list; else the provider's current static list (claude/devin). |
| model / effort | `validate_model_and_effort` **before** anything reaches the agent; model → `session/set_config_option` `configId:"model"`; effort → the `thought_level`/`model_config` select if present, else dropped. |

### 2.1 Lossy-but-contained mappings (no contract change)

- **`developer_instructions`** (set by the interviewer service, `interview.py:414`) has no
  ACP field. It is prepended to the first `session/prompt` content block. Storage of the
  session id is unchanged.
- **`effort`** has no baseline ACP field; it is applied only if the agent exposes a
  reasoning config option. Otherwise ignored (never sent as raw argv).
- **One-shot tasks are not `ephemeral` in ACP.** Each `run_task` = `session/new` + prompt;
  the session is closed if the agent advertises `close`, otherwise it lives until
  `dispose`. Same observable one-shot semantics; documented.

## 3. Per-provider support matrix (verified on this machine, 2026-10-07)

| kind | ACP agent | command | version | `loadSession` | auth | decision |
|---|---|---|---|---|---|---|
| **opencode** | native | `opencode acp` | 1.14.40 | **true** (also `sessionCapabilities` fork/list/resume) | `authMethods: [opencode-login]`; creds from local `opencode auth login` | **migrate → AcpRuntime** |
| **devin** | native | `devin acp` | 3000.11.3 (agentInfo `affogato`) | **true** (`sessionCapabilities` list/delete/additionalDirectories; no `resume`) | `authMethods: [devin-browser]`; creds from local `devin auth login` | **migrate → AcpRuntime** |
| **claude** | adapter, **not installed** | `claude-code-acp` (npm `@zed-industries/claude-code-acp` 0.16.2) | — | n/a | inherits `claude` login | **keep legacy** `claude_agent_sdk` adapter |
| **codex** | adapter, **not installed** | `codex-acp` (npm `@zed-industries/codex-acp` 0.16.0) | — | n/a | inherits `codex login` | **keep legacy** `exec` + `app-server` adapter |
| **mock** | n/a | — | — | — | — | unchanged |

`opencode` and `devin` were probed live: both answered `initialize` with
`protocolVersion: 1` and `agentCapabilities.loadSession: true`, and both returned a
`session/new` result carrying `configOptions` with a `category:"model"` select (the model
list for `list_models`). claude 2.1.2 / codex 0.160.1 expose **no** `acp` subcommand — they
need the Zed adapters above, which are not on `PATH`; hence they keep their adapters and are
revisited when the adapter is installed.

Custom providers: an `interview-os.runtimes.json` entry may declare an ACP agent command
(argv array, `cwd`/workspace, env allowlist, model mapping). Trusted local config only,
never HTTP — same posture as today's module providers.

## 4. Dependency & SDK check

- PyPI `agent-client-protocol`: latest **stable 0.12.1**, published **2026-08-16** — within
  `exclude-newer = "2026-09-28"` (`apps/api/pyproject.toml`). Newest is `1.0.0rc2`
  (2026-09-21, pre-release).
- **Decision: add no dependency.** `codex/process.py` already implements the identical
  ndjson JSON-RPC transport over `asyncio` subprocess; ACP adds only method names. `ai/acp/`
  reuses `ai/process.py` (`spawn_command`, `_terminate`, `launch_spec`) + `json`. This
  satisfies "check the existing stack covers it" in both `AGENTS.md` files.

## 5. Security posture (Phase-2 gate)

- **Client capabilities advertise nothing dangerous**: `clientCapabilities = {fs:{readTextFile:false, writeTextFile:false}, terminal:false}`. Omit `auth.terminal`, `elicitation`, and `session.configOptions.boolean` entirely.
- **`session/request_permission` is always rejected.** Reply `{outcome:{outcome:"selected", optionId:<reject_once|reject_always>}}`, or `{outcome:{outcome:"cancelled"}}` when no reject option exists. The agent never gets an allow.
- **Every other server→client request is refused** with a JSON-RPC error — `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `elicitation/create`, and any `_*` extension. We never fulfil file, terminal, or elicitation requests.
- **Untrusted text (resumes, JDs, answers, documents) travels only inside `session/prompt` content blocks over stdin.** Never argv, never env, never a shell string. The ACP client logs event *types* and byte **lengths**, never content. Nothing logs `authMethods` or tokens.
- **Child env** goes through each provider's allowlist, carried over verbatim into its
  `AcpAgentConfig` (from the old `child_env.py`); the Windows required-env merge in
  `ai/process.py` is preserved. No full-environment passthrough.
- **`mcpServers` is always `[]`.** MCP servers are never forwarded to an agent.
- **argv arrays only, no `shell=True`.** stderr is drained and never surfaced in errors (as codex does today).
- **Auth** is the user's own local login (`opencode auth login`, `devin auth login`); the client never calls `authenticate`. `session/new` `auth_required` → typed `RuntimeError("UNAVAILABLE", <setup hint>)`.

## 6. Consumers — confirmed unchanged

`run_structured` (schema still validated/retried), interviewer session thread
(`create_session`/`send_message`/`resume_session`), `RuntimeManager` hot-swap
(`ai/manager.py`), `GET /api/runtime/available`, `PUT /api/runtime`,
`runtime_sessions` rows (`runtime_session_id` + `thread_id` semantics identical to codex),
`middleware.py` (`MiddlewareRuntime` wraps whatever `AIRuntime` it is given), custom
providers, and `MockRuntime`. Provider `kind` strings and `data/<kind>-workspace` dirs are
unchanged, so saved `runtimeKind` settings and stored `runtime_sessions` rows still resolve.

## 7. What landed (Phase 3)

- `ai/acp/`: `client.py` (JSON-RPC stdio transport, request ids, notifications, cancellation,
  stderr drain, permission refusal), `runtime.py` (`AcpRuntime`), `detect.py`, `events.py`,
  `config.py` (`AcpAgentConfig` + env allowlist).
- `providers.py`: `OPENCODE_ACP` / `DEVIN_ACP` `AcpRuntime` configs — same kind strings and
  `data/<kind>-workspace` dirs, so saved `runtimeKind` and `runtime_sessions` rows resolve;
  declarative `{ "kind", "acp": { "command", "args", "env" } }` entries in
  `interview-os.runtimes.json` (trusted local config only).
- `tests/fixtures/fake-acp-agent.mjs` (no tokens) + `tests/ai/test_acp.py`.
- Deleted: `ai/opencode/`, `ai/devin/` and their tests + `fake_provider_cli.mjs`.
- `client.close()` reaps the whole child process tree on Windows (`taskkill /T`), so a
  launcher's child (Devin spawns one) cannot outlive `dispose`/`cancel`.

## 8. Remaining legacy adapters (with reasons)

- **claude** — `ai/claude/` (Agent SDK). No ACP agent on this machine; the Zed adapter
  `claude-code-acp` (`@zed-industries/claude-code-acp` 0.16.2) is not installed.
- **codex** — `ai/codex/` (exec + app-server). No ACP agent on this machine; the Zed adapter
  `codex-acp` (`@zed-industries/codex-acp` 0.16.0) is not installed.

Both become `AcpRuntime` configs (a few lines in `providers.py`) once the adapter binary is on
`PATH` and verified.

## 9. Phase-4 verification

- `uv run ruff check` clean; `uv run mypy src tests` clean; `uv run pytest` green, including
  `tests/integration/test_feedback_loop.py`.
- `pnpm test:contract` green with **no contract/golden re-recording**.
- `pnpm typecheck` green.
- `pnpm test:e2e`: all specs pass except two that fail *identically on the unmodified tree* —
  `core-loop.spec.ts` (missing `input[aria-label="Upload resume file"]` on `/target`, line 100)
  and `plugin-api.spec.ts:58` (missing "Suggestions from plugins" on `/prepare`). Pre-existing
  frontend / plugin-UI failures, unrelated to this change (e2e was already removed from the
  required checks in `946fb52`).
- Security (adversarial pass): `session/request_permission` always answers with the reject
  option; `fs/read_text_file` + other server→client requests get JSON-RPC `-32601`; the
  `initialize` capabilities advertise `fs.{read,write}TextFile:false` and `terminal:false`;
  prompts travel only in `session/prompt` over stdin (never argv/env); the child env is the
  provider allowlist; `mcpServers` is always `[]`; malformed agent JSON → `MALFORMED_OUTPUT`
  and a mid-stream crash → `CRASHED`.
- Opt-in live smoke tests: `INTERVIEW_OS_LIVE_OPENCODE=1` / `INTERVIEW_OS_LIVE_DEVIN=1`.
