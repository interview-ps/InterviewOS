# Interview OS — Architecture

Interview OS keeps a **continuously updated, evidence-backed model of a candidate's interview
readiness** and drives preparation and interviews from it. Everything below serves that loop:

```
Resume + JD → resume-analyzer → jd-analyzer → gap-analyzer → prep-planner
   → interview (planner + interviewer) → answer-evaluator → evidence → readiness recompute
   → prep-planner update → next interview retests weak skills ↺ → interview-debrief
```

## 1. Repository layout

```
apps/
  server/      Hono HTTP API (port 4100). Owns SQLite + the provider child process, the
               InterviewOrchestrator, and the skill implementations
               (src/orchestrator/, src/skills/).
  web/         Vite + React Router SPA + Tailwind UI. In dev it runs on port 3000 and proxies
               /api/* to the server; in prod the built SPA (apps/web/dist) is served by the
               server on port 4100 alongside the API.
packages/
  core/        Zod schemas = canonical shared state; taxonomy; readiness math; gaps;
               question prioritisation; interview state machine; companies; resume
               checks; skill manifests; shared logger (redacting, JSON lines), ids,
               errors. Pure + deterministic.
  runtime/     AIRuntime interface; MockRuntime; CodexRuntime, ClaudeCodeRuntime,
               OpencodeRuntime, DevinRuntime (one provider per directory).
examples/      backend-engineer (canonical), product-manager, data-engineer: resume.md + job.md
tests/         cross-package integration (canonical loop), fake-codex fixture, e2e (Playwright)
data/          interview-os.db (gitignored), <provider>-workspace/ (empty, sandbox cwd per provider)
```

Package names: `@interview-os/{core,runtime,server,web}` (the repo root is the private
`interview-os` workspace).
Dependency direction (strict): `core ← runtime ← server`; `web`
talks to `server` only over HTTP and may import **types/schemas** from `core`.

## 2. Shared state (packages/core)

Canonical Zod schemas, one module per area: `candidate/`, `target/`, `assessment/`,
`readiness/`, `preparation/`, `interview/`. `InterviewOSState` is the aggregate:

```ts
InterviewOSState = {
  candidate:   { id, name?, headline?, experience[], skills: CandidateSkill[], projects[],
                 achievements[], education[], starStories[] },
  target:      { id, company, role, level: 'junior'|'mid'|'senior'|'staff', jobDescription,
                 requirements: Requirement[], preferredSkills: Requirement[] },
  assessment:  { strengths[], gaps: Gap[], weakAnswers[], strongAnswers[], observations[],
                 skillAssessments: Record<SkillId, SkillReadiness> },
  preparation: { priorities: SkillId[], completedTopics[], nextActions: PrepAction[],
                 practiceHistory[] },
  interview:   { sessionId?, currentRound, previousQuestions[], previousAnswers[],
                 interviewerObservations[], activeQuestion? },
  readiness:   { overall, overallConfidence, dimensions: Record<SkillId, SkillReadiness>,
                 lastUpdated },
}
```

Key types:
- `SkillId`: dotted lowercase path, regex `^[a-z0-9-]+(\.[a-z0-9-]+)*$`, e.g.
  `distributed-systems.caching.cache-invalidation`. Parent = dotted prefix.
- `CandidateSkill { skillId, level: 0..1, source: 'resume', evidence: string }`
- `Requirement { skillId, label, importance: 0..1, kind: 'required'|'preferred', evidence }`
- `Evidence { id, skillId, type: 'resume_claim'|'interview_answer'|'practice'|'self_report',
   score: 0..1, confidence: 0..1, observation, sessionId?, questionId?, createdAt }`
- `SkillReadiness { skillId, label, score: number|null, confidence, evidenceIds[],
   children: SkillId[], status: 'unknown'|'weak'|'developing'|'strong' }`
- `Gap { skillId, label, importance, targetScore, currentScore|null, gap, uncertainty,
   severity: 'low'|'medium'|'high', reason }`
- `PrepAction { id, skillId, priority, reason, action, successCriteria: string[],
   status: 'open'|'in_progress'|'done'|'superseded', createdAt, sourceEvidenceIds[] }`

**Invariant:** no skill or module defines its own candidate/target/readiness shape. They import
from `@interview-os/core`.

### Taxonomy (`core/taxonomy`)
Seed tree of skills with `{ id, label, keywords[] }` (keywords drive the MockRuntime and skill-id
normalisation). Must include at least: `python`, `apis` (`apis.rest`), `sql` (`sql.query-optimization`,
`sql.indexing`), `distributed-systems` (`.caching` → `.cache-strategies`, `.cache-invalidation`;
`.message-queues`, `.consistency`, `.partitioning`, `.replication`), `system-design`
(`.requirements-analysis`, `.capacity-estimation`, `.scalability`, `.reliability`), `behavioral`
(`.leadership`, `.conflict`), `communication`, plus a few PM / data-engineering skills for examples.
Unknown AI-produced ids are accepted if they match the regex; nodes are created on demand.

### Readiness math (`core/readiness`) — deterministic, evidence-derived
For a skill with evidence list E (sorted newest first, rank r = 0..n-1):
```
w_i   = confidence_i × typeWeight(type_i) × 0.85^r_i
typeWeight: interview_answer 1.0, practice 0.7, self_report 0.3, resume_claim 0.4
direct.score      = Σ w_i·score_i / Σ w_i            (null if E empty)
direct.confidence = min(0.95, 1 − exp(−Σ w_i / 1.5))
```
Parent rollup: if a node has children with scores, combine `direct` and the mean of child scores
weighted by child confidence (children count as one pseudo-evidence with weight = mean child
confidence). Nodes with no evidence anywhere: `score=null, confidence=0, status='unknown'`.
Status: `<0.5 weak`, `<0.75 developing`, else `strong`.
Overall = importance-weighted mean over target requirements, unknown skills contribute prior 0.25;
overallConfidence = importance-weighted mean confidence.
Every recompute writes a **snapshot** row (never overwrite): `{skillId, score, confidence,
evidenceIds, reason, computedAt}`. Current readiness = latest snapshot per skill.

### Gaps (`core/gaps`)
`targetScore` by level: junior 0.6, mid 0.7, senior 0.8, staff 0.85.
`gap = max(0, targetScore − (currentScore ?? 0))`, `uncertainty = 1 − confidence`.
Severity: `importance×gap ≥ 0.45 high`, `≥ 0.2 medium`, else `low`. Sorted by
`importance×gap×(0.5+uncertainty)` desc, tie-break skillId asc.

### Question prioritisation (`core/interview/prioritize`) — transparent heuristic
```
priority = roleImportance × max(readinessGap, 0.1) × (0.5 + uncertainty) × recencyAdjustment
recencyAdjustment:
   asked in current session (same skill)        → 0.15
   has weak interview evidence (score < 0.5)    → 1.6   (previously weak areas get retested)
   asked in previous session and not weak       → 0.6
   otherwise                                    → 1.0
```
Candidates = target requirements + their taxonomy children that have evidence + low-confidence
skills. Every 4th question of a session is a strong-area confirmation (highest score with
confidence < 0.8). The selector returns `{ skillId, priority, reason }` — the reason is shown in UI.
Exact question texts are never repeated (dedupe against all previous question texts).

### Interview state machine (`core/interview/state-machine`)
```
CREATED → ANALYZING → READY → QUESTION → ANSWER → EVALUATING → FOLLOW_UP
FOLLOW_UP → QUESTION | COMPLETE ;  QUESTION → COMPLETE (early end) ;  COMPLETE → DEBRIEF ;
EVALUATING → QUESTION (evaluation_failed: evaluation failure returns to QUESTION so the answer can be resubmitted; the failed answer row is marked `status='failed'`)
```
`transition(state, event)` throws `InvalidTransitionError` for anything else. Server state is
the source of truth; a session has `plannedQuestions` (default 4).

## 3. Runtime (packages/runtime)

```ts
interface AIRuntime {
  readonly kind: 'codex' | 'mock' | 'claude' | 'opencode' | 'devin';
  healthCheck(): Promise<RuntimeStatus>;          // {runtime, available, version?, executable?, status, message?, workspace?}
  runTask(task: AgentTask): Promise<AgentResult>; // one-shot
  createSession(input: SessionInput): Promise<RuntimeSession>;      // {id, threadId}
  resumeSession(threadId: string, input: SessionInput): Promise<RuntimeSession>;
  sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent>;
  closeSession(sessionId: string): Promise<void>;
  listModels(): Promise<ModelInfo[]>;              // {id, displayName,
                                                   //  supportedReasoningEfforts,
                                                   //  defaultReasoningEffort, isDefault?}
  dispose(): Promise<void>;
}
AgentTask   = { taskId: string /* skill id */, instructions: string, input: unknown,
                outputSchema: JSONSchema, timeoutMs?: number }
AgentResult = { ok: true, output: unknown /* parsed JSON */, raw: string, durationMs, events }
            | { ok: false, error: RuntimeError, raw?: string, durationMs, events }
RuntimeMessage = { text: string, taskId?: string, input?: unknown, outputSchema?: JSONSchema }
RuntimeEvent = {type:'started'} | {type:'delta', text} | {type:'message', text}
             | {type:'completed', output?: unknown, raw: string} | {type:'error', error}
RuntimeError.code: 'UNAVAILABLE'|'SPAWN_FAILED'|'CRASHED'|'TIMEOUT'|'MALFORMED_EVENT'|'MALFORMED_OUTPUT'|'PROTOCOL'
```
Factory `createRuntime(opts)` (`{env?, workspaceDir?, logger?, preferredKind?, onSwitch?}`):
`INTERVIEW_OS_RUNTIME=codex|mock|claude|opencode|devin` (default `codex`;
if the selected runtime is unavailable at startup the server logs it, reports status, and falls
back to mock **only** when `INTERVIEW_OS_RUNTIME_FALLBACK=mock`; otherwise AI actions return 503
with setup instructions). Each provider defaults to its own workspace dir
(`data/<provider>-workspace`, overridable with `INTERVIEW_OS_<PROVIDER>_WORKSPACE`; mock shares
`data/codex-workspace`).

`createRuntime` returns a **`RuntimeManager`** — an `AIRuntime` that delegates to the active
provider and can swap it without a restart. Selection precedence: the env var > the persisted
`runtimeKind` setting (chosen in Settings) > `codex`. `GET /api/runtime/available` probes every
provider's detect path (PATH scan + `--version`) in parallel; `PUT /api/runtime {kind}` switches,
persists `runtimeKind`, and re-resolves the saved model against the new provider's catalog.
Switching disposes the old delegate — its live sessions die and rehydrate via `resumeSession`
on the new provider. `onSwitch` fires for the initial runtime and every switch (the server uses
it to register mock handlers).

### MockRuntime
Deterministic, no network. Dispatches on `task.taskId` to handlers that use taxonomy keyword
matching over the provided input (resume text, JD text, answer text vs `expectedConcepts`).
Supports the full v0.1 flow including sessions. Same input ⇒ same output.

### CodexRuntime (`runtime/codex/`)
- `detect.ts`: locate executable (`INTERVIEW_OS_CODEX_BIN` or PATH lookup in Node — no shell),
  `execFile(bin, ['--version'])` with 5 s timeout → version.
- `CodexExecAdapter.ts` (used by `runTask`): `spawn(bin, ['exec','--json','--skip-git-repo-check',
  '--ephemeral','-s','read-only','-C',workspace,'--output-schema',schemaFile,'-'])`; prompt via
  **stdin**; JSONL parsed by `CodexEventParser` (`thread.started`, `turn.started`,
  `item.completed{agent_message}`, `turn.completed`, `turn.failed`, `error`); last agent_message
  is the structured output. Captures start, events, output, errors, exit code, duration.
- `CodexProcess.ts`: owns one long-lived `codex app-server --listen stdio://` child; JSON-RPC
  over newline-delimited JSON (`initialize` → `initialized` notification). Auto-restarts on crash.
  Server→client requests (approvals, `item/tool/requestUserInput`, etc.) are **declined**.
- `CodexProtocol.ts`: typed request/notification shapes actually used: `initialize`,
  `thread/start {cwd, sandbox:'read-only', approvalPolicy:'never', developerInstructions,
  ephemeral:false}`, `thread/resume {threadId}`, `turn/start {threadId, input:[{type:'text',
  text, text_elements:[]}], outputSchema}`, notifications `item/agentMessage/delta`,
  `item/completed`, `turn/completed`, `error`.
- `CodexSessionManager.ts`: Interview OS session id ↔ Codex thread id; resumes threads after
  restart (mapping persisted by orchestrator in `runtime_sessions`).
- Security: argv arrays only; user content only on stdin / JSON-RPC payload; env allowlist
  (`PATH, HOME, USER, LANG, LC_ALL, TMPDIR, CODEX_HOME, XDG_*`, `OPENAI_API_KEY` if set) — never
  logged; cwd = `data/codex-workspace`; read-only sandbox; no browser-reachable shell.
- Timeouts (default 120 s per task, configurable `INTERVIEW_OS_CODEX_TIMEOUT_MS`) kill the child.

### ClaudeCodeRuntime (`runtime/claude/`)
`AIRuntime` over `@anthropic-ai/claude-agent-sdk`. `detect.ts` locates the CLI
(`INTERVIEW_OS_CLAUDE_BIN`/PATH, `--version`). `runTask` sets
`outputFormat:{type:'json_schema',schema}` and reads the result's `structured_output`. Sessions are
one-shot: `createSession` returns a local opaque `threadId` and `sendMessage` runs a fresh
`runTask` carrying the full prompt (no server-side resume). `listModels()` uses
`supportedModels()` with a static `default/sonnet/opus/haiku` fallback. Child env allowlist:
`PATH, HOME, USER, LANG, LC_ALL, TMPDIR, CLAUDE_CONFIG_DIR, ANTHROPIC_*` — never the full env,
never logged. Permission mode `dontAsk`; no tools exposed for one-shot tasks.

### OpencodeRuntime (`runtime/opencode/`)
`AIRuntime` over one-shot `opencode run --format json` CLI invocations (no `opencode serve`, no
SDK). The prompt — including the JSON Schema and input — is written to the child's **stdin**
(never argv, so Windows `.cmd` shims work and untrusted text is never shell-interpreted); the
assistant text parts are collected from the NDJSON stream and parsed as structured output. A
per-task timeout (`INTERVIEW_OS_OPENCODE_TIMEOUT_MS`) kills the process. Sessions are one-shot:
`createSession` returns a local opaque `threadId` and `sendMessage` runs a fresh task. Model ids
are provider-qualified (`provider/model`) from `opencode models`. Child env allowlist excludes
provider API keys (opencode reads them from its own auth store).

### DevinRuntime (`runtime/devin/`)
`AIRuntime` over one-shot `devin -p --prompt-file <file>` CLI invocations. The prompt — including
the JSON Schema and input — is written to a temp file inside the workspace and passed by path
(never argv or stdin: untrusted text is never shell-interpreted, and the CLI's `-p` mode does not
read a piped prompt); the assistant's stdout is parsed as structured output. A per-task timeout
(`INTERVIEW_OS_DEVIN_TIMEOUT_MS`) kills the process. Sessions are one-shot: `createSession`
returns a local opaque `threadId` and `sendMessage` runs a fresh task (no server-side resume).
`listModels()` tries `devin models list --format json` (newer CLI versions) and falls back to
static family aliases (`adaptive`, `swe`, `opus`, `sonnet`, `gpt`, `codex`, `gemini`). Child env
allowlist adds the Windows config roots (`APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `HOMEDRIVE`,
`HOMEPATH`) and `DEVIN_*`/`WINDSURF_API_KEY` — credentials stay in the CLI's own auth store
(`devin auth login`).

## 4. Skills (apps/server/src/skills)

```ts
interface InterviewSkill<I, O> {
  id: string;                         // e.g. 'resume-analyzer'
  inputSchema: z.ZodType<I>; outputSchema: z.ZodType<O>;
  execute(input: I, ctx: SkillContext): Promise<O>;
}
SkillContext = { runtime: AIRuntime; logger; sessionId?: string; now(): Date }
```
`runStructured(ctx, {taskId, instructions, input, schema})` helper: converts Zod → JSON Schema
(`zod-to-json-schema` or Zod v4 `z.toJSONSchema`), calls runtime, validates with Zod, on
failure retries up to 2× appending the validation error; then throws `SkillOutputError`.
Prompts are small, per-skill, in `prompt.ts`; untrusted resume/JD/answer text is wrapped in
delimited data blocks with an instruction to treat it as data, never instructions.

| Skill | AI? | Input → Output |
|---|---|---|
| resume-analyzer | yes | resumeText → candidate (experience, skills w/ level+evidence, projects, achievements, education, starStories) |
| jd-analyzer | yes | {jobDescription, company, role, level} → requirements[], preferredSkills[] |
| gap-analyzer | no (core/gaps) | target + readiness → Gap[] |
| prep-planner | yes (+deterministic priority) | gaps + weaknesses + existing actions → PrepAction[] (concrete action + successCriteria) |
| interviewer | yes (session thread when available) | selected skill + context + previous questions → {question, topic, skillId, subSkills[], expectedConcepts[], difficulty} |
| answer-evaluator | yes (independent one-shot) | question + expectedConcepts + answer → evaluation (below) |
| interview-debrief | yes | session Q/A/evaluations + readiness delta → {summary, wentWell[], toImprove[], nextActions[]} |

§8–§9 add `company-profiler`, `star-coach`, `resume-coach`, `interview-planner`, and
`loop-debrief`; see those sections for their inputs/outputs.

Evaluation output: `{ summary, dimensions: {correctness, technicalDepth, reasoning, structure,
communication, evidence, roleRelevance} each {score 0..1, rationale}, strengths[{skill,
evidence}], weaknesses[{skill, severity, evidence}], scores[{skill, score, confidence}],
missingConcepts[], betterApproach, followUpTopics[] }`.

## 5. Orchestrator + persistence (apps/server/src/orchestrator)

`InterviewOrchestrator` holds workflow only: `setupWorkspace`, `analyzeCandidate`,
`analyzeTarget`, `calculateGaps`, `buildPreparationPlan`, `startInterview`, `nextQuestion`,
`submitAnswer` (→ evaluate → evidence → recompute readiness → update plan), `completeInterview`,
`createDebrief`, `getState`, `getSkillDetail`. Single local user; one active candidate+target.

SQLite tables (append-only where history matters): `candidate_profiles, target_roles,
interview_sessions, interview_questions, candidate_answers, answer_evaluations, skill_nodes,
skill_evidence, readiness_scores (snapshots), preparation_actions, runtime_sessions`.
Resume claims become `resume_claim` evidence; interview evaluations become `interview_answer`
evidence (one per `scores[]` entry, observation from matching strength/weakness).

## 6. API (apps/server)

```
GET  /api/state                     full InterviewOSState + session summaries
POST /api/workspace/setup           {resumeText, jobDescription, company, role, level} → full pipeline
POST /api/analysis/resume | /job | /gaps
GET  /api/preparation   POST /api/preparation/recalculate   PATCH /api/preparation/:id {status}
POST /api/interviews    GET /api/interviews   GET /api/interviews/:id
POST /api/interviews/:id/answer {answer}   POST /api/interviews/:id/next
POST /api/interviews/:id/complete          GET /api/interviews/:id/debrief
GET  /api/readiness     GET /api/readiness/:skillId   (score, confidence, evidence, history, actions)
GET  /api/runtime/status  POST /api/runtime/check
```
Errors: JSON `{error:{code,message}}`. Request bodies validated with Zod; body size limit 200 KB.

## 7. Observability
`@interview-os/core` logger (core/src/shared) emits JSON lines `{ts, level, event, ...fields}` for:
`workflow.started|completed|failed, skill.invoked, runtime.invoked (latencyMs), output.validated
|invalid, state.mutated, evaluation.recorded, readiness.updated`. Redacts keys matching
`/token|key|secret|password|authorization|cookie/i`; resume/JD/answer text is logged only as length.

## 8. v0.2 additions

### 8.1 Loop depth
- **Time decay** (core/readiness): `w_i = confidence_i × typeWeight × 0.85^rank × 0.5^(ageDays_i / halfLife(type))`,
  halfLife days: interview_answer 60, practice 45, self_report 30, resume_claim 180. `buildReadinessGraph`
  takes `now`. Displayed readiness is always computed live at read time; snapshots still append on recompute.
- **Practice evidence**: completing a prep action offers (a) a self-check over its success criteria →
  one `self_report` evidence (score = checked/total, confidence 0.5, observation lists checked criteria),
  and (b) "Verify with a question" → a practice session (`mode:'practice'`, `plannedQuestions:1`,
  `focusSkillId` = action skill; selection bypasses the heuristic). Answers in practice sessions produce
  `practice` evidence instead of `interview_answer`. Any of these → recompute readiness → plan update.
- **Multiple targets per candidate**: evidence/readiness stay candidate-level (carry across targets);
  requirements, gaps, prep actions (`target_id` column) and sessions are per target. One active target;
  switching re-derives gaps/plan for that target. API: `GET /api/targets`, `POST /api/targets`
  `{jobDescription, company, role, level, companyNotes?}` (analyse JD for the active candidate),
  `POST /api/targets/:id/activate`.

### 8.2 Documents
`POST /api/documents/extract` (multipart `file`, ≤5 MB) → `{text, format, pages?, warnings[]}`.
PDF via `unpdf`, DOCX via `mammoth`, txt/md decoded as UTF-8. Format decided by magic bytes
(`%PDF-`, `PK\x03\x04` + `word/document.xml`), not by filename. Processed in memory, never shelled out;
text normalised and truncated to 50 000 chars (warning when truncated or empty, e.g. scanned PDF).

### 8.3 Live Codex UX
- **Task mode**: `runTask` on Codex runs either via `exec` (v0.1) or via an **ephemeral app-server thread**
  on the warm process (`thread/start {ephemeral:true, sandbox:'read-only', approvalPolicy:'never'}` +
  `turn/start {outputSchema}`). Setting `taskMode: 'app-server' | 'exec'`, default `app-server`.
- **Streaming**: `AgentTask.onEvent?(e: RuntimeEvent)` receives `delta` events (Codex
  `item/agentMessage/delta`; MockRuntime chunks its JSON output into deltas). `SkillContext.onProgress?(p)`
  with `p = {stage} | {field, text}`; `runStructured` extracts the in-progress value of the skill's
  `streamField` from the partial JSON (`extractPartialStringField(buf, field)`) — interviewer:`question`,
  answer-evaluator:`summary`, interview-debrief:`summary`, star-coach:`feedback`.
- **SSE**: long endpoints accept `Accept: text/event-stream` (or `?stream=1`) and respond with events
  `stage {name}`, `delta {field, text}` (full text so far), `result {…same JSON as non-stream…}`,
  `error {code,message}`. Applies to workspace/setup, targets create, interviews create/next/answer/complete,
  stories generate/coach. Non-stream JSON behaviour unchanged.
- **Settings** (SQLite `settings` key/value): `model: string|null` (null = provider default),
  `reasoningEffort: 'low'|'medium'|'high'|null`, `taskMode` (Codex-only). A one-time migration copies
  the legacy `codexModel` key to `model`. `GET /api/settings`, `PUT /api/settings`,
  `GET /api/runtime/models` (`{id, displayName, supportedReasoningEfforts, defaultReasoningEffort,
  isDefault?}`; mock → `[{id:'mock'}]`). A saved model absent from the live catalog falls back to the
  entry flagged `isDefault` and is persisted. Model must match `^[A-Za-z0-9._:-]+(/[A-Za-z0-9._:-]+)?$`
  (≤128 chars) before it reaches argv (`-m`, `-c model_reasoning_effort=…`) or an SDK/JSON-RPC payload
  (`model`/`effort`). Approvals: fixed read-only sandbox + decline-all, shown read-only with an explanation.

### 8.4 Interview breadth
- **Round types**: session `roundType: 'mixed'|'technical'|'system_design'|'behavioral'|'hr'` (default mixed =
  v0.1 behaviour). `core/interview/rounds.ts` `inRound(skillId, roundType)`: technical = not
  system-design/behavioral/communication/hr subtrees; system_design = `system-design.*` +
  `distributed-systems.*`; behavioral = `behavioral.*` + `communication`; hr = `hr.*`. Pool filtered before
  prioritisation; if empty, the round's taxonomy nodes join with importance 0.6. Taxonomy adds `hr`
  (`.motivation`, `.career-goals`, `.culture-fit`, `.work-style`) and `behavioral` children
  (`.ownership`, `.failure-learning`, `.collaboration`). Interviewer prompt gets `roundType` + company themes.
- **STAR**: `AnswerEvaluation.star: {situation, task, action, result: boolean, notes} | null` (filled for
  behavioral/hr). `star_stories` table (id, candidateId, title, situation, task, action, result, skillIds,
  source 'resume'|'generated'|'user', updatedAt). Skill `star-coach`: mode `generate` (experience +
  achievements + behavioral requirements → story drafts) and mode `review` (story → `{feedback, missing[],
  suggestions[], improvedDraft}`). Behavioral interviewer receives story titles to probe. API:
  `GET /api/stories`, `POST /api/stories/generate`, `PATCH /api/stories/:id`, `POST /api/stories/:id/coach`.
- **Company profile**: optional pasted `companyNotes` (untrusted) on a target → skill `company-profiler` →
  `{values[], interviewStyle, focusSkillIds[], behavioralThemes[]}` stored in target data. Requirements whose
  skill is in `focusSkillIds` get +0.05 importance (cap 0.95); themes feed behavioral/HR interviewer prompts.
  No web research.

## 9. v0.3 — Complete interview preparation platform

Theme: simulate the real, multi-stage interview process and carry evidence across rounds.

### 9.1 Interview modes (one module per mode — no giant interviewer)
`ModeId = 'technical'|'coding'|'system_design'|'behavioral'|'hiring_manager'|'hr'`; `RoundType = ModeId | 'mixed'`
(`mixed` kept for v0.2 sessions). Pure mode definitions live in `core/interview/modes/<mode>.ts`:
```ts
ModeDefinition {
  id, label, description,
  inScope(skillId): boolean,  fallbackSkills: SkillId[],
  rubric: {id, label, description}[],               // evaluated independently
  initialState(): ModeState,  reduce(state, evaluation, question): ModeState,
  followUp(evaluation, state, depth, maxDepth): {ask: boolean, focus?: string, reason: string},
}
```
Scopes: technical = everything except system-design/behavioral/communication/hr/coding/hiring-manager subtrees;
coding = `coding.*`; system_design = `system-design.*` + `distributed-systems.*`; behavioral = `behavioral.*` +
`communication`; hiring_manager = `hiring-manager.*` + `behavioral.leadership` + `communication`; hr = `hr.*`.
(Deviation worth noting: coding scope cannot reach `sql.transactions`, so a loop that needs to seed a
transactions weakness must open with a `technical` round — the canonical loop test does exactly that.)
Taxonomy adds `coding` (`.algorithms`, `.data-structures`, `.complexity`, `.edge-cases`, `.code-quality`),
`hiring-manager` (`.role-fit`, `.scope-impact`, `.prioritization`, `.leadership-style`), `sql.transactions`,
`system-design.data-modeling`, `system-design.async-processing`, and **`related` edges** (symmetric), e.g.
`sql.transactions↔distributed-systems.consistency`, `sql.transactions↔system-design.data-modeling`,
`distributed-systems.caching.cache-invalidation↔distributed-systems.consistency`,
`distributed-systems.message-queues↔system-design.async-processing`, `coding.complexity↔system-design.scalability`.

Rubrics (ids): technical `correctness, technicalDepth, reasoning, communication, roleRelevance`;
coding `problemUnderstanding, approach, correctness, complexity, edgeCases, codeQuality, communication`;
system_design `requirements, constraints, scaleAssumptions, architecture, dataModel, apis, storage, caching,
reliability, scalability, tradeOffs`; behavioral `situationClarity, ownership, actions, decisionMaking, impact,
results, reflection, communication`; hiring_manager `roleFit, scopeImpact, prioritization, leadership,
collaboration, motivation`; hr `motivation, careerGoals, cultureFit, workStyle, communication`.
`AnswerEvaluation.rubric: {id, label, score, rationale}[]` must contain exactly the mode's rubric ids (validated;
mismatch = malformed → retry). Generic `dimensions` stays for compatibility.

Mode state (session column `mode_state` JSON):
- system_design: one design problem per session; `{problem, dimensions: Record<rubricId(excluding
  communication), {status:'not_covered'|'partial'|'covered', notes}>}`. Turn 1 = design prompt; later turns probe
  the first not_covered/partial dimension in rubric order. Evaluator returns `designUpdates[{dimension, status,
  notes}]`; `reduce` applies them (status never downgrades).
- coding: `{problem: {title, statement, constraints[], examples[{input, output, explanation}]}, phase}`;
  answers carry `{text, code?, language?}` (answers table gains `code`, `language`). **No code execution in
  v0.3** — code is reviewed, not run (UI says so); execution sandboxing is v0.4.
- behavioral: `{storyIdsUsed[], competenciesCovered[]}`; hiring_manager / hr: `{themesCovered[]}`; technical `{}`.

Skills: interviewer and answer-evaluator dispatch to per-mode modules `apps/server/src/skills/interview/modes/<mode>/`
(`interviewerPrompt`, `evaluatorPrompt`, mock templates, mock rubric scorer) with taskIds
`interviewer.<mode>` / `answer-evaluator.<mode>`; `mixed` uses the v0.2 prompts.

Follow-ups: after each evaluation the mode's `followUp` decides. technical/behavioral/hiring_manager/hr: ask when
missingConcepts is non-empty and any rubric score < 0.6 and depth < maxDepth; coding: when complexity or
edgeCases < 0.6; system_design: the session itself walks uncovered dimensions (not counted as depth).
Follow-up questions are persisted with `followUpOf` + `followUpFocus`, asked in the same Codex thread with
`followUp: {parentQuestion, focus}`, and do **not** count toward `plannedQuestions`.
`maxDepth` = company profile `followUpDepth` (default 1).

### 9.2 Adaptive question engine v3 (`core/interview/prioritize`)
```
priority = roleImportance × max(readinessGap, 0.1) × (0.5 + uncertainty)
         × weaknessBoost × recencyFactor × noveltyFactor
weaknessBoost: 1.6 weak interview evidence (<0.5) on the skill; 1.4 related to (or equal to) a skill flagged weak
               in an earlier round of the current loop; else 1.0
recencyFactor: 0.15 asked this session (and then weaknessBoost = 1.0); 0.6 asked in previous session & not weak; else 1.0
noveltyFactor: 0.85 if asked ≥ 3 times across all sessions and not weak; else 1.0
```
Pool = in-scope requirements + in-scope evidenced descendants + low-confidence skills + in-scope
loop-weak skills and their in-scope `related` skills; empty → mode fallbackSkills at importance 0.6. Every 4th
main question is a strong-area confirmation (in scope). Difficulty: base by level (junior easy, mid medium,
senior medium, staff hard), +1 step if score ≥ 0.75, −1 if score < 0.4. Selection returns
`factors {roleImportance, readinessGap, uncertainty, weaknessBoost, recencyFactor, noveltyFactor}`, `difficulty`
and a human reason (e.g. "Round 1 (Coding) showed weak Transactions → testing Consistency"); stored on the
question (`selection_factors`) and shown in the UI. With no loop and novelty 1.0 this equals the v0.2 formula.

### 9.3 Company profiles (`core/companies/`)
Built-in, originally-written data: `generic, google, meta, amazon, microsoft`.
```ts
CompanyProfile { id, name, aliases[], disclaimer, typicalLoop: {mode, label, plannedQuestions}[],
  emphasis: {skillId, weight ≤ 0.1}[], behavioralFramework: {name, themes[], guidance},
  followUpDepth: 1|2|3, rubricEmphasis: Partial<Record<rubricId, number>>, roleExpectations: Record<Level, string[]> }
```
Disclaimer on every profile: "Based on commonly reported public interview patterns; real loops vary by team, role
and level." Targets get `companyProfileId` (auto by alias match on company name, else `generic`; user can
change). Emphasis boosts requirement importance (cap 0.95, `boostedBy: 'company-profile:<id>'`); the v0.2
pasted-notes profile remains an overlay. Profile guidance feeds interviewer/evaluator prompts.

### 9.4 Full interview loops
Table `interview_loops {id, target_id, company_profile_id, rounds JSON [{mode, label, plannedQuestions,
sessionId|null, status, readinessBefore, readinessAfter, handoff, skillDeltas}], status 'planned'|'in_progress'|
'complete', current_round, created_at, completed_at, debrief JSON}`; sessions gain `loop_id`, `loop_round`.
`startLoop({rounds?})` (default = company typicalLoop) creates round 1's session; completing a round's session
writes its debrief, a deterministic **handoff** `{weakSkills[{skillId,label,score,observation}],
strongSkills[{skillId,label,score}], observations[]}` (from that round's evaluations — labels resolve via the
taxonomy so UI/prompts never show raw ids), **skillDeltas** `[{skillId, label, before, after}]` — first-before /
last-after per skill across the round's evaluations' `readinessDelta` — and readiness before/after, then
`advanceLoop` creates the next round's session. Later rounds get `loopWeakSkills` (selection, §9.2) and
`priorRoundObservations` (interviewer prompt). Final round → skill `loop-debrief` → `{summary, rounds[{mode,
signal:'strong'|'mixed'|'weak', evidence[]}], readinessChange, topActions[]}` — signals with evidence, never a
hire/no-hire verdict.

### 9.5 Resume coach
- Deterministic `core/resume/ats.ts` `atsCheck(resumeText, requirements)` → `{score 0–100, checks[{id, label,
  status:'pass'|'warn'|'fail', detail, weight}], keywordCoverage {present[], missing[]}}`: contact info, section
  headings, length (300–900 words), bullet count, quantified-bullet ratio (≥30%), action-verb starts, first-person
  pronouns, dates present, required-skill keyword coverage (taxonomy keywords for each required skill). Score = weighted pass ratio.
- Skill `resume-coach` (`resume-coach.bullets`, `resume-coach.tailor`): bullets → `{suggestions[{original,
  improved, rationale, skillIds}]}`; tailor → `{summary, emphasize[], deEmphasize[], alignment[{requirement,
  resumeEvidence|null, suggestion}], prepGaps[]}`. Bullet selection is section-aware: only bullets inside
  experience/projects-style sections are candidates — education, skills, contact, summary etc. are never
  rewritten as achievements (`core/resume/bullets.ts`).
- **No invented facts** guard `core/resume/guard.ts` `guardSuggestion(original, improved, resumeText)`: numbers /
  percentages / currency not present in the resume are replaced with `[add metric]`; capitalised multi-letter
  tokens (entities) absent from the resume and from a small common-word allowlist → suggestion dropped. Applied
  to every AI suggestion before persisting.
- `resume_reviews {id, candidate_id, target_id, ats, suggestions, tailoring, created_at}`.

### 9.6 Skill manifests, plugins, permissions
`Permission = candidate.read|candidate.write|target.read|target.write|readiness.read|evidence.write|
interview.read|interview.write|stories.read|stories.write|resume.read|resume.write|preparation.write|
taxonomy.read|runtime.invoke`.
`SkillManifest {id, version, kind:'builtin'|'plugin', description, inputs[{key, permission}], outputs[],
permissions[]}` (Zod). Every built-in skill exports one. `SkillHost` (`apps/server/src/skills/host/`):
`invoke(id, input, ctx)` rejects (PermissionError) any top-level input key not declared in `inputs` or whose
permission isn't granted; `ctx.runtime` is a proxy that throws unless `runtime.invoke`; the orchestrator calls
`host.assertCan(id, '<x>.write')` before persisting a skill's outputs. All orchestrator skill calls go through the
host.
Plugins: `plugins/<name>/{skill.yaml, index.ts}` loaded at server start from `INTERVIEW_OS_PLUGINS_DIR`
(default `<repo>/plugins`, installed plugins in `data/plugins`); kind forced to `plugin`; plugins may hold
read permissions + `runtime.invoke` + `evidence.write` (other write permissions → rejected at load).
`GET /api/plugins` lists manifests + permission views; `POST /api/plugins/:id/run` builds the plugin input
**from state, only for declared *and* granted slices**. Since v0.4 plugins run in an isolated child process
— see §10.1. Sample: `plugins/interview-day-checklist` (target.read + readiness.read, no runtime).

### 9.7 History, metrics, command palette, UI
- Evaluations store `readinessDelta[{skillId, before, after}]`; History shows mode, company profile, target,
  loop/round, questions (+follow-ups), answers (+code), rubric, readiness changes, prep actions created (actions
  whose sourceEvidenceIds intersect the session's evidence). Filters: mode, target, loop, weak answers.
- Local `usage_events {id, event, created_at}` (no content). `GET /api/metrics`: loops started/completed,
  modes used, weakness retest rate (weak skills later asked again ÷ weak skills), improvement after prep (mean
  per-skill score delta between evidence before and after a done action), prep completion rate (done ÷ non-
  superseded), history reviews, target switches, resume coach uses, readiness coverage (% requirements with
  confidence ≥ 0.4).
- Command palette (Ctrl/Cmd+K): static + dynamic commands (start <mode> interview, start full loop, practice
  <skill>, view <skill> readiness, analyze new JD, switch target, review weak answers, open resume coach).
- Navigation: Home, Target, Prepare (Plan | Stories), Interview (Single round | Full loop), Readiness, Resume,
  History, Settings (+ Skills & plugins). Old routes redirect. UI polish: shared PageHeader (title, subtitle,
  actions) on every page, consistent empty states with a primary CTA, loading skeletons, non-blocking toasts,
  visible focus rings, consistent pill tones for status/severity/signal, and a sidebar that collapses to a menu
  button below 900px.
- Test-only endpoint: `POST /api/test/reset` wipes all state — it returns 404 unless
  `INTERVIEW_OS_TEST_MODE=1` (e2e isolation; never enabled in dev/prod).

## 10. v0.4 — extensible platform

### 10.1 Plugin host (`apps/server/src/plugins`, `packages/plugin-sdk`)
Plugins are directories with `skill.yaml` (or `manifest.json`) + an entry file exporting
`defineSkill({id, permissions, capabilities?, inputs?, execute})` from `@interview-os/plugin-sdk`.
Manifests are slug-id'd (`SLUG_ID_REGEX`), `kind` forced to `plugin`, and any `*.write` other than
`evidence.write` is rejected at load. Each run spawns a Node child process with `--permission`
(`executor.ts` + `runner.mjs`): fs scoped to the plugin dir, no env inheritance (`SystemRoot` only on
Windows), network/child-process/`module`/`wasi`/`repl` blocked via a resolve hook, `fetch`/`WebSocket`/
`process.binding` removed, 30 s timeout, capped output. The plugin receives only input slices that are
both declared in `inputs` and granted by the user (`PluginView.grantedPermissions`); `ctx.runtime`
exists only with a granted `runtime.invoke`. `evidenceProposals` in plugin output are proposal-only:
`EvidenceProposalSchema`-validated, confidence capped at `PLUGIN_EVIDENCE_CONFIDENCE_CAP` (0.6),
persisted as `type:"plugin"` / `source:"plugin:<id>"` by the orchestrator only when `evidence.write`
was granted. Installed plugins (`data/plugins`) start disabled; enabling is a separate user action.

### 10.2 Pack registry (`apps/server/src/packs`, `packages/core/src/packs`)
`PackRegistry` synchronously loads bundled `packs/` and installed `data/packs/` trees:
`companies/` (`CompanyPackSchema` + overlays → `compileCompanyPack` → `CompanyProfile`),
`roles/` (`RolePackSchema`), `interview/` (`InterviewPackSchema` YAML). Company/role packs install
from git (`cloneShallow` — no prompts, no credential helpers); interview packs are stored in the
`interview_packs` table with create/export/import/delete. **Provenance:** every pack item is
`sourced` (must cite a declared `sources[].id`, enforced by schema refinement) or `community`
(rendered "unverified" in UI and prompts). Pack/company content is labeled `Sourced:`/`Community
observation:` in interviewer guidance.

### 10.3 Question-source routing
`nextQuestionInternal` gathers candidates in order — user question bank → company-pack overlays →
role-pack questions → enabled `question_source` plugins (`request.kind:"questions"`) — picks the
first eligible candidate, and otherwise falls back to the generated interviewer question. Sources
only *suggest*; the orchestrator always decides the skill and never lets a source inject follow-ups.
Candidate questions are `QuestionCandidateSchema`-validated and filtered to the target skill/mode; a
failing/disabled source just falls through. Settings `questionSources` toggles each source family.

### 10.4 MCP context (`apps/server/src/mcp`, `orchestrator/mcp-service.ts`)
`McpManager` lazily spawns SDK stdio clients for servers defined **only** in local
`interview-os.mcp.json` (never HTTP; missing file → none, invalid → surfaced `loadError`). Servers
are disabled by default; each tool needs an explicit `allowedTools` entry (`mcp_servers` table).
Child env is minimal + declared `envPassthrough` names only; args ≤ 4 KB; results truncated to 12 000
chars; 30 s timeout; values never logged or returned. `fetchExternalContext` stores text in
`external_contexts`; `StartInterviewInput.contextId` injects it into the interviewer as fenced,
untrusted reference data. Plugins have no MCP access.

### 10.5 Voice (interaction layer only)
`core/interview/voice.ts`: `VoiceMetricsSchema` (client-measured duration/pauses), deterministic
`voiceFeedback(metrics, transcript)` → `VoiceSignalSchema[]` (structure/filler/pauses/length/
conclusion/clarity) + counts + `VOICE_DISCLAIMER`. The client appends a transcript plus `voice`
metrics on answer submit; the server recomputes counts, stores `{metrics, feedback}` on the answer
row, and returns `voiceFeedback`. The evaluator input and evidence are unchanged — voice never
influences evaluation.

### 10.6 Export / import (`core/platform/export.ts`, `orchestrator/export-service.ts`)
`ExportBundleSchema` covers the 16 user-data tables (runtime_sessions, plugin_installs, mcp_servers,
usage_events excluded; settings allowlisted — never `runtimeKind`). `exportState`/`exportStatePart`
emit the full bundle or one part; `importState(bundle, {mode:"replace"})` validates the whole bundle
(schema + id uniqueness + referential checks) *before* writing, then wipes and inserts in one
`Store.transaction` and appends a readiness snapshot with reason `import`. HTTP: `GET /api/export[/:part]`
(dated attachments), `POST /api/import {bundle, confirm:"replace"}` under a 25 MB body limit.

### 10.7 Plugin UI extensions (`packages/ui`, `orchestrator/plugin-service.ts`, `http/routes/ui.ts`)
Plugins may add experiences only through **declared** extension points, in three levels:
(1) `kind:"declarative"` contributions — the plugin returns a `UINode` tree
(`core/platform/ui-schema.ts`: depth ≤ 8, ≤ 300 nodes, no html/style/url fields), validated by
`validateUITree` at `POST /api/plugins/:id/ui/render` and rendered by the host's
`DeclarativeRenderer` (`@interview-os/ui/renderer`);
(2) `kind:"frame"` contributions — plugin-authored components bundled to `ui/index.js`
(`interview-os build-ui`), rendered inside a **sandboxed opaque-origin iframe**
(`sandbox="allow-scripts"` only) served by `GET /api/plugins/:id/ui/frame` with
`connect-src 'none'` CSP and a per-response nonce; the frame's only channel is the
postMessage bridge (`PluginFrame` + `lib/plugin-frame-bridge.ts`), which enforces
source-window identity, envelope schema, 64 KB cap, 20 msg/s rate limit, and a closed
`UIAction` vocabulary; `getData`/`run` hit `POST .../ui/data` and `.../ui/run`, which reuse
the declared+granted slice gating of a normal plugin run;
(3) full plugin pages at `/plugins/<id>/<path>` (declarative or frame).
`ui` sections require capability `ui`; contributions auto-enable with the plugin and are
listed in the permission review. `interviewModes` add plugin-declared session presets
(`pluginModeId` on `POST /api/interviews` → `interview_sessions.focus_skills` → planner
`packFocus`); `taxonomy` registers new skill nodes at load. The iframe never gets
same-origin, DOM, storage, network, or remote-script access — see `docs/security.md`.

### 10.8 Plugin API v1 + runtime providers (`core/platform/plugin-api.ts`, `runtime/providers.ts`)

Plugin API v1 replaces ad-hoc `request.kind` dispatch with a versioned hook
contract: `PLUGIN_HOOKS` maps each hook to `{capability, request, response}`
Zod schemas; the host validates both directions (`PLUGIN_OUTPUT` on invalid
responses, fail-soft per caller). Plugins implement `handlers` (typed per hook)
or keep legacy `execute`; manifest `hooks` + runner `describe()` give the
loader the capability↔hook coverage check. `engines["plugin-api"]` (default
`^1.0.0`) is semver-checked like `interview-os`.

| Extension point | Contract | Who decides |
| --- | --- | --- |
| Question suggestions | `questions.suggest` | core routes; plugin suggests candidates |
| Prep resources | `resources.suggest` | plugin suggests; host fills skill/source |
| UI | `ui.render` / `ui.frameRun` | plugin returns tree/output; host renders/sandboxes |
| Answer review | `evaluation.review` | plugin observes; host persists attributed reviews |
| Prep suggestions | `preparation.suggest` + accept | plugin suggests; user accepts |
| Interview modes | manifest `interviewModes` + guidance | plugin declares; core runs the session |
| Lifecycle events | `events.*` hooks | core fires outside the lock; proposals gated |
| Company/role packs | `packs/` in plugin dir | PackRegistry loads; collisions are errors |
| Settings/KV | manifest `settings`, `ctx.storage` | host validates/stores; plugin-owned data |
| AI runtime | `interview-os.runtimes.json` → `registerRuntimeProvider` | trusted local config only, never HTTP |

`RuntimeManager` gained a provider registry (`packages/runtime/src/providers.ts`):
`registerRuntimeProvider` adds `create`/`healthCheck` for a non-builtin slug;
`allRuntimeKinds`/`isRuntimeKind`/probing/switching consult it. Providers load
at startup from `interview-os.runtimes.json` (`loadRuntimeProviders`; errors
are surfaced, startup continues) and are tagged `trustedLocal` in
`GET /api/runtime/available`.
