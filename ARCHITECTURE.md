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
  server/      Hono HTTP API (port 4100). Owns SQLite + the local Codex process.
  web/         Next.js (App Router) + Tailwind UI (port 3000). /api/* rewritten to server.
packages/
  shared/      logger (redacting, JSON lines), ids, errors, clock
  core/        Zod schemas = canonical shared state; taxonomy; readiness math; gaps;
               question prioritisation; interview state machine. Pure + deterministic.
  runtime/     AIRuntime interface; MockRuntime; LocalCodexRuntime (exec + app-server).
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
  readonly kind: 'codex' | 'mock';
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
Factory `createRuntime(env)`: `INTERVIEW_OS_RUNTIME=mock|codex` (default `codex`; if Codex is
unavailable at startup the server logs it, reports status, and falls back to mock **only** when
`INTERVIEW_OS_RUNTIME_FALLBACK=mock`; otherwise AI actions return 503 with setup instructions).

### MockRuntime
Deterministic, no network. Dispatches on `task.taskId` to handlers that use taxonomy keyword
matching over the provided input (resume text, JD text, answer text vs `expectedConcepts`).
Supports the full v0.1 flow including sessions. Same input ⇒ same output.

### LocalCodexRuntime (`runtime/codex/`)
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
- **Settings** (SQLite `settings` key/value): `codexModel: string|null` (null = Codex default),
  `reasoningEffort: 'low'|'medium'|'high'|null`, `taskMode`. `GET /api/settings`, `PUT /api/settings`,
  `GET /api/runtime/models` (Codex `model/list` → `{id, displayName, supportedReasoningEfforts,
  defaultReasoningEffort}`; mock → `[{id:'mock'}]`). Model must be in the list and match
  `^[A-Za-z0-9._:-]+$` before it reaches argv (`-m`, `-c model_reasoning_effort=…`) or JSON-RPC
  (`model`/`effort` on `thread/start`/`turn/start`). Approvals: fixed read-only sandbox + decline-all, shown
  read-only with an explanation.

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

Skills: interviewer and answer-evaluator dispatch to per-mode modules `skills/src/interview/modes/<mode>/`
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
  pronouns, dates present, required-skill keyword coverage (taxonomy `matchSkills`). Score = weighted pass ratio.
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
permissions[]}` (Zod). Every built-in skill exports one. `SkillHost` (`skills/src/host/`):
`invoke(id, input, ctx)` rejects (PermissionError) any top-level input key not declared in `inputs` or whose
permission isn't granted; `ctx.runtime` is a proxy that throws unless `runtime.invoke`; the orchestrator calls
`host.assertCan(id, '<x>.write')` before persisting a skill's outputs. All orchestrator skill calls go through the
host.
Plugins: `plugins/<name>/{manifest.json, index.ts}` loaded at server start from `INTERVIEW_OS_PLUGINS_DIR`
(default `<repo>/plugins`); kind forced to `plugin`; v0.3 plugins may hold only read permissions +
`runtime.invoke` (write permissions → plugin skipped with a logged warning). `GET /api/skills` lists manifests;
`POST /api/plugins/:id/run` builds the plugin input **from state, only for declared input slices**; runs are
time-boxed at 30 s and output is capped at 100 KB. Plugins are trusted local code (documented).
Sample: `plugins/interview-day-checklist` (target.read + readiness.read, no runtime).

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
