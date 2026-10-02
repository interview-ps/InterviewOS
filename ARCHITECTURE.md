# Interview OS — Architecture (v0.1)

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
  server/      Hono HTTP API (port 4100). Owns SQLite + the provider child process.
  web/         Next.js (App Router) + Tailwind UI (port 3000). /api/* rewritten to server.
packages/
  shared/      logger (redacting, JSON lines), ids, errors, clock
  core/        Zod schemas = canonical shared state; taxonomy; readiness math; gaps;
               question prioritisation; interview state machine. Pure + deterministic.
  runtime/     AIRuntime interface; MockRuntime; CodexRuntime, ClaudeCodeRuntime,
               OpencodeRuntime (one provider per directory).
  skills/      The 7 v0.1 skills. Each = typed input → typed output (Zod-validated).
  orchestrator/ InterviewOrchestrator (workflow only) + SQLite store (drizzle + better-sqlite3).
examples/      backend-engineer (canonical), product-manager, data-engineer: resume.md + job.md
tests/         cross-package integration (canonical loop), fake-codex fixture, e2e (Playwright)
data/          interview-os.db (gitignored), codex-workspace/ (empty, sandbox cwd for Codex)
```

Package names: `@interview-os/{shared,core,runtime,skills,orchestrator,server,web}`.
Dependency direction (strict): `shared ← core ← runtime ← skills ← orchestrator ← server`; `web`
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
  readonly kind: 'codex' | 'mock' | 'claude' | 'opencode';
  healthCheck(): Promise<RuntimeStatus>;          // {runtime, available, version?, executable?, status, message?, workspace?}
  runTask(task: AgentTask): Promise<AgentResult>; // one-shot
  createSession(input: SessionInput): Promise<RuntimeSession>;      // {id, threadId}
  resumeSession(threadId: string, input: SessionInput): Promise<RuntimeSession>;
  sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent>;
  closeSession(sessionId: string): Promise<void>;
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
Factory `createRuntime(env)`: `INTERVIEW_OS_RUNTIME=codex|mock|claude|opencode` (default `codex`;
if the selected runtime is unavailable at startup the server logs it, reports status, and falls
back to mock **only** when `INTERVIEW_OS_RUNTIME_FALLBACK=mock`; otherwise AI actions return 503
with setup instructions). Each provider defaults to its own workspace dir
(`data/<provider>-workspace`, overridable with `INTERVIEW_OS_<PROVIDER>_WORKSPACE`).

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

## 4. Skills (packages/skills)

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

Evaluation output: `{ summary, dimensions: {correctness, technicalDepth, reasoning, structure,
communication, evidence, roleRelevance} each {score 0..1, rationale}, strengths[{skill,
evidence}], weaknesses[{skill, severity, evidence}], scores[{skill, score, confidence}],
missingConcepts[], betterApproach, followUpTopics[] }`.

## 5. Orchestrator + persistence (packages/orchestrator)

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
`@interview-os/shared` logger emits JSON lines `{ts, level, event, ...fields}` for:
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
