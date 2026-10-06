import type {
  CandidateProfile,
  CompanyNotesProfile,
  CompanyProfile,
  Evidence,
  Gap,
  InterviewOSState,
  InterviewPack,
  PrepAction,
  PrepResource,
  Question,
  QuestionCandidate,
  ReadinessGraph,
  SkillReadiness,
  TargetRole,
  UIAction,
  UINode,
} from "@interview-os/frontend-types";

export type AppState = InterviewOSState;
export type { CandidateProfile, Gap, PrepAction, Question, SkillReadiness, Evidence, TargetRole };

/** Prep action as returned by the API (v0.4 adds learning resources). */
export type PrepActionView = PrepAction & { resources: PrepResource[] };
export type { PrepResource, QuestionCandidate, InterviewPack };

export interface ExpectedConcept {
  concept: string;
  skillId: string;
  keywords: string[];
}

/** v1: a round/mode id — "mixed" or any plugin-provided mode (availability is server-side). */
export type RoundType = string;

/** v1.1: one declarative answer widget for `answerFormat: "fields"` modes. */
export interface ModeAnswerField {
  key: string;
  label: string;
  type: "text" | "code" | "choice" | "number";
  options?: string[];
  required?: boolean;
}

/** v1: an interview mode the server says new sessions may use (GET /api/modes). */
export interface AvailableMode {
  id: string;
  label: string;
  description: string;
  rubric: { id: string; label: string; description: string }[];
  answerFormat: "text" | "text+code" | "fields";
  answerFields?: ModeAnswerField[];
  pluginId?: string;
}

export type DesignDimensionStatus = "not_covered" | "partial" | "covered";

export interface SessionRow {
  id: string;
  candidateId: string | null;
  targetId: string | null;
  status: string;
  currentRound: number;
  plannedQuestions: number;
  mode: "interview" | "practice";
  roundType: RoundType;
  modeLabel?: string;
  /** v1: how this session collects answers — drives the answer UI. */
  answerFormat?: "text" | "text+code" | "fields";
  /** v1.1: declared answer widgets for "fields" sessions (empty otherwise). */
  answerFields?: ModeAnswerField[];
  modeState: Record<string, unknown>;
  focusSkillId: string | null;
  actionId: string | null;
  /** §9.4: set when this session is a loop round (1-based). */
  loopId: string | null;
  loopRound: number | null;
  /** v0.4: external context this session is grounded on (nullable). */
  contextId: string | null;
  createdAt: string;
  completedAt: string | null;
}

// --- v0.4 voice mode (delivery hints only; never part of evaluation) --------

export interface VoiceMetrics {
  durationSec: number;
  longPauseCount: number;
  longestPauseSec: number;
}

export type VoiceSignalId =
  | "structure"
  | "filler"
  | "pauses"
  | "length"
  | "conclusion"
  | "clarity";

export interface VoiceSignal {
  id: VoiceSignalId;
  status: "ok" | "watch";
  message: string;
}

export interface VoiceFeedback {
  signals: VoiceSignal[];
  wordCount: number;
  fillerCount: number;
  wordsPerMinute: number | null;
  disclaimer: string;
}

export interface StoredVoice {
  metrics: VoiceMetrics;
  feedback: VoiceFeedback;
}

export interface SelectionFactors {
  roleImportance: number;
  readinessGap: number;
  uncertainty: number;
  weaknessBoost: number;
  recencyFactor: number;
  noveltyFactor: number;
  /** v0.4: interview-pack focus bonus (present for pack-started loops). */
  packFocus?: number;
}

export interface CodingProblem {
  title: string;
  statement: string;
  constraints: string[];
  examples: { input: string; output: string; explanation?: string }[];
}

export interface QuestionExtra {
  problem?: CodingProblem | string;
  focusDimension?: string;
}

export interface SessionQuestion extends Question {
  selectionReason: string | null;
  selectionPriority: number | null;
  selectionFactors: SelectionFactors | null;
  followUpOf: string | null;
  followUpFocus: string | null;
  extra: QuestionExtra | null;
  /** v0.4: which question source provided this question (null = generated). */
  source: QuestionCandidate["source"] | null;
}

export interface AnswerRow {
  id: string;
  questionId: string;
  sessionId: string;
  text: string;
  code: string | null;
  language: string | null;
  /** v0.4: delivery metrics + feedback when voice mode captured them. */
  voice: StoredVoice | null;
  status: string;
  createdAt: string;
}

export interface DimensionScore {
  score: number;
  rationale: string;
}

export interface RubricDimension {
  id: string;
  label: string;
  score: number;
  rationale: string;
}

export interface Evaluation {
  summary: string;
  dimensions: Record<string, DimensionScore>;
  rubric: RubricDimension[];
  designUpdates: { dimension: string; status: DesignDimensionStatus; notes: string }[] | null;
  strengths: { skill: string; evidence: string }[];
  weaknesses: { skill: string; severity: string; evidence: string }[];
  scores: { skill: string; score: number; confidence: number }[];
  missingConcepts: string[];
  betterApproach: string;
  followUpTopics: string[];
  star: {
    situation: boolean;
    task: boolean;
    action: boolean;
    result: boolean;
    notes: string;
  } | null;
}

export interface Debrief {
  summary: string;
  wentWell: string[];
  toImprove: string[];
  nextActions: string[];
}

export interface SessionDetail {
  session: SessionRow;
  questions: SessionQuestion[];
  answers: AnswerRow[];
  evaluations: Evaluation[];
  debrief: Debrief | null;
  companyProfile: { id: string; name: string; disclaimer: string } | null;
}

export interface InterviewListItem extends SessionRow {
  target: { id: string; role: string; company: string } | null;
  questions: number;
  debrief: Debrief | null;
}

export type { CompanyNotesProfile, CompanyProfile };
export type CompanyProfileInfo = CompanyProfile;

export interface TargetListItem {
  id: string;
  company: string;
  role: string;
  level: string;
  active: boolean;
  createdAt: string;
  companyProfile: CompanyNotesProfile | null;
  companyProfileId: string | null;
  boostedSkillIds: string[];
}

/** Persisted resume + active target sources (prefill for the setup form). */
export interface WorkspaceSources {
  resumeText: string;
  jobDescription: string;
  company: string;
  role: string;
  level: string;
  companyNotes: string | null;
  hasCandidate: boolean;
  hasTarget: boolean;
}

export interface ExtractResult {
  text: string;
  format: "pdf" | "docx" | "txt" | "md";
  pages?: number;
  warnings: string[];
}

export interface StartInterviewResult {
  session: SessionRow | undefined;
  question: SessionQuestion | null;
}

export interface SubmitAnswerResult {
  evaluation: Evaluation;
  skillImpact: { skillId: string; before: number | null; after: number | null }[];
  newActions: PrepActionView[];
  nextAvailable: "question" | "complete";
  /** v0.4: delivery hints when the client sent voice metrics. */
  voiceFeedback: VoiceFeedback | null;
  /** v1: review observations from evaluation plugins (attributed). */
  pluginReviews?: PluginReviewView[];
}

export interface PluginReviewView {
  pluginId: string;
  pluginName: string;
  observations: { text: string; tone: "green" | "amber" | "red" | "blue" | "muted" }[];
}

export interface PluginSettingField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  options?: string[];
  default?: string | number | boolean;
  description?: string;
}

export interface PluginSuggestionGroup {
  pluginId: string;
  pluginName: string;
  activities: {
    skillId: string;
    title: string;
    action: string;
    successCriteria: string[];
  }[];
}

export interface SkillDetail {
  skillId: string;
  readiness: SkillReadiness | null;
  evidence: (Evidence & { sessionId: string | null; questionId: string | null })[];
  history: { id: number; score: number | null; confidence: number; computedAt: string; reason: string }[];
  actions: PrepActionView[];
  recommendedAction: PrepActionView | null;
}

export interface RuntimeStatus {
  runtime: string;
  available: boolean;
  version?: string;
  executable?: string;
  workspace?: string;
  status: string;
  message?: string;
  mode: string;
}

export interface RuntimeProbe {
  runtime: string;
  available: boolean;
  version?: string;
  executable?: string;
  workspace?: string;
  status: string;
  message?: string;
  /** v1: loaded from interview-os.runtimes.json (trusted local code). */
  trustedLocal?: boolean;
}

export interface RuntimeAvailability {
  active: string;
  providers: RuntimeProbe[];
}

export interface ExampleMeta {
  name: string;
  resumeText: string;
  jobDescription: string;
  company: string;
  role: string;
  level: string;
  companyNotes?: string;
}

export interface StarStory {
  id: string;
  candidateId: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  skillIds: string[];
  source: "resume" | "generated" | "user";
  updatedAt: string;
}

export interface StoryCoachResult {
  feedback: string;
  missing: string[];
  suggestions: string[];
  improvedDraft: { situation: string; task: string; action: string; result: string };
}

export interface SetupResult {
  candidate: CandidateProfile;
  target: TargetRole;
  gaps: Gap[];
  actions: PrepActionView[];
}

// --- §9.4 interview loops ---------------------------------------------------

export interface ReadinessSnapshot {
  overall: number | null;
  requirements: Record<string, number | null>;
}

export interface RoundHandoff {
  weakSkills: { skillId: string; label: string; score: number; observation: string }[];
  strongSkills: { skillId: string; label: string; score: number }[];
  observations: string[];
}

export interface SkillDelta {
  skillId: string;
  label: string;
  before: number | null;
  after: number | null;
}

export interface LoopRound {
  mode: RoundType;
  label: string;
  plannedQuestions: number;
  sessionId: string | null;
  status: "pending" | "in_progress" | "complete";
  readinessBefore: ReadinessSnapshot | null;
  readinessAfter: ReadinessSnapshot | null;
  handoff: RoundHandoff | null;
  skillDeltas: SkillDelta[];
}

export interface LoopRoundSignal {
  mode: string;
  label: string;
  signal: "strong" | "mixed" | "weak";
  evidence: string[];
}

export interface LoopDebrief {
  summary: string;
  rounds: LoopRoundSignal[];
  readinessChange: { before: number | null; after: number | null };
  topActions: string[];
}

export interface InterviewLoop {
  id: string;
  targetId: string | null;
  companyProfileId: string;
  rounds: LoopRound[];
  status: "planned" | "in_progress" | "complete";
  currentRound: number;
  abandoned: boolean;
  debrief: LoopDebrief | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StartLoopResult {
  loop: InterviewLoop;
  session: SessionRow;
  question: SessionQuestion | null;
}

export interface CompleteInterviewResult {
  session: SessionRow;
  debrief: Debrief;
  loop: InterviewLoop | null;
  nextSession: SessionRow | null;
  nextQuestion: SessionQuestion | null;
}

// --- §9.7 history / metrics -------------------------------------------------

export interface HistoryQuestion {
  question: SessionQuestion;
  answer: {
    id: string;
    text: string;
    code: string | null;
    language: string | null;
    voice: StoredVoice | null;
    createdAt: string;
  } | null;
  evaluation: Evaluation | null;
  readinessDelta: { skillId: string; before: number | null; after: number | null }[];
  weak: boolean;
}

export interface HistoryEntry {
  session: SessionRow;
  target: {
    id: string;
    role: string;
    company: string;
    companyProfileId: string;
  } | null;
  loop: { id: string; round: number | null; totalRounds: number; label: string | null } | null;
  questions: (HistoryQuestion & { followUps: HistoryQuestion[] })[];
  actionsCreated: PrepActionView[];
  debrief: Debrief | null;
  hasWeakAnswer: boolean;
}

export interface Metrics {
  loopsStarted: number;
  loopsCompleted: number;
  sessionsPerMode: Record<string, number>;
  weaknessRetestRate: { weakSkills: number; retested: number; rate: number | null };
  improvementAfterPrep: number | null;
  prepCompletionRate: { done: number; total: number; rate: number | null };
  readinessCoverage: { covered: number; total: number; rate: number | null };
  usage: Record<string, number>;
}

// --- §9.5 resume coach / §9.6 skills & plugins -------------------------------

export interface AtsCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  weight: number;
}

export interface AtsResult {
  score: number;
  checks: AtsCheck[];
  keywordCoverage: {
    present: { skillId: string; label: string; snippet: string }[];
    missing: { skillId: string; label: string }[];
  };
}

export interface ResumeSuggestion {
  original: string;
  improved: string;
  rationale: string;
  skillIds: string[];
  dropped?: string;
}

export interface ResumeTailoring {
  summary: string;
  emphasize: string[];
  deEmphasize: string[];
  alignment: {
    requirement: string;
    resumeEvidence: string | null;
    suggestion: string;
  }[];
  prepGaps: string[];
}

export interface ResumeReview {
  id: string;
  candidateId: string;
  targetId: string;
  ats: AtsResult;
  suggestions: ResumeSuggestion[];
  tailoring: ResumeTailoring | null;
  linkedGapSkillIds: string[];
  guard: { substitutions: number; dropped: number };
  createdAt: string;
}

export interface SkillInfo {
  id: string;
  version: string;
  kind: "builtin" | "plugin";
  description: string;
  inputs: { key: string; permission: string }[];
  outputs: string[];
  permissions: string[];
}

export interface SkillsList {
  skills: SkillInfo[];
  pluginErrors: { dir: string; file: string; error: string }[];
}

// --- v0.4 packs / question bank ----------------------------------------------

export interface PackItemView {
  group: string;
  text: string;
  provenance: "sourced" | "community";
  source?: string;
}

export interface CompanyPackView {
  id: string;
  name: string;
  version: string;
  source: string;
  description: string;
  aliases: string[];
  stages: { mode: string; label: string; plannedQuestions: number; provenance: string; source?: string }[];
  sources: { id: string; title: string; url?: string }[];
  items: PackItemView[];
  sourcedCount: number;
  communityCount: number;
}

export interface RolePackView {
  id: string;
  name: string;
  version: string;
  source: string;
  description: string;
  dimensions: { skillId: string; weight: number }[];
  defaultQuestionCategories: string[];
  resources: PrepResource[];
}

export interface PackListView {
  companies: CompanyPackView[];
  roles: RolePackView[];
  loadErrors: { path: string; error: string }[];
}

// --- v0.4 plugins --------------------------------------------------------------

export interface PluginPermissionEntry {
  category: string;
  access: "READ" | "WRITE" | "INVOKE" | "DENIED" | "UI";
  requested: boolean;
  granted: boolean;
  detail?: string;
}

/** v0.4: UI contributions an enabled plugin declares (mirrors server view). */
export interface PluginUIContributionView {
  pluginId: string;
  pluginName: string;
  navigation: { label: string; icon: string; page: string }[];
  commands: { id: string; label: string; action: UIAction }[];
  slots: Partial<
    Record<
      string,
      { component: string; kind: "declarative" | "frame"; title?: string; entry?: string }[]
    >
  >;
  pages: {
    path: string;
    title: string;
    kind: "declarative" | "frame";
    component: string;
    entry?: string;
  }[];
  /** v1: interview mode ids this plugin owns (`modes` manifest section). */
  modes: string[];
  interviewModes: {
    id: string;
    label: string;
    roundType: RoundType;
    focusSkills: string[];
    plannedQuestions: number;
  }[];
}

export type { UIAction, UINode } from "@interview-os/frontend-types";

export interface PluginView {
  manifest: {
    id: string;
    version: string;
    name?: string;
    author?: string;
    description: string;
    capabilities?: string[];
    permissions: string[];
    engines?: Record<string, string>;
  };
  enabled: boolean;
  grantedPermissions: string[];
  source: "bundled" | "git" | "memory";
  compatible: boolean;
  permissions: PluginPermissionEntry[];
  loadError?: string;
}

export interface PluginRunResult {
  output: unknown;
  evidenceWritten: number;
  evidenceIgnored: number;
  evidenceRejected?: string;
}

export interface InterviewPackInfo {
  pack: InterviewPack;
  source: "bundled" | "user" | "imported";
  createdAt?: string;
  updatedAt?: string;
}

export interface InterviewPackInput {
  name: string;
  description?: string;
  author?: string;
  version?: string;
  skills: string[];
  rounds: { mode: RoundType; label: string; plannedQuestions: number }[];
  durationMinutes: number;
}

export interface UserBankQuestion {
  skillId: string;
  text: string;
  difficulty?: "easy" | "medium" | "hard";
  mode?: RoundType;
  source: { kind: "user_bank"; id: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface StreamHandlers<T> {
  onStage?: (name: string) => void;
  onDelta?: (field: string, text: string) => void;
  onResult?: (result: T) => void;
  onError?: (err: ApiError) => void;
}

/**
 * POST with SSE progress (?stream=1). Events: stage / delta / result / error.
 * Resolves with the result payload — identical shape to the plain POST. The
 * `error` SSE event (HTTP 200) is surfaced as an ApiError like HTTP errors.
 */
export async function streamPost<T>(
  path: string,
  body: unknown,
  handlers: StreamHandlers<T> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${path}${path.includes("?") ? "&" : "?"}stream=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
  } catch {
    const err = new ApiError(0, "NETWORK", "Could not reach the Interview OS server.");
    handlers.onError?.(err);
    throw err;
  }
  if (!res.ok || !res.body) {
    const parsed = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    const err = new ApiError(
      res.status || 500,
      parsed?.error?.code ?? "UNKNOWN",
      parsed?.error?.message ?? `Request failed (${res.status})`,
    );
    handlers.onError?.(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: T | undefined;
  let streamError: ApiError | null = null;
  // The server heartbeats every 10s; ~60s without any frame means a proxy or
  // the network silently ate the stream — fail rather than spin forever.
  let lastFrameAt = Date.now();
  const watchdog = setInterval(() => {
    if (result !== undefined || streamError) return;
    if (Date.now() - lastFrameAt > 60_000) {
      streamError = new ApiError(
        0,
        "STREAM_STALLED",
        "No progress for 60s — the server connection stalled. Check the server and retry.",
      );
      handlers.onError?.(streamError);
      void reader.cancel().catch(() => {});
    }
  }, 5_000);

  const dispatch = (event: string, raw: string) => {
    const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (event === "stage") {
      handlers.onStage?.(String(payload.name ?? ""));
    } else if (event === "delta") {
      handlers.onDelta?.(String(payload.field ?? ""), String(payload.text ?? ""));
    } else if (event === "result") {
      result = payload as T;
      handlers.onResult?.(payload as T);
    } else if (event === "error") {
      streamError = new ApiError(
        200,
        String(payload.code ?? "UNKNOWN"),
        String(payload.message ?? "streamed operation failed"),
      );
      handlers.onError?.(streamError);
    }
  };

  for (;;) {
    // `result`/`error` are terminal frames — resolve on the frame itself
    // rather than waiting for stream close: dev proxies can hold the final
    // bytes of a long-lived SSE response.
    if (result !== undefined || streamError) {
      void reader.cancel().catch(() => {});
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    lastFrameAt = Date.now();
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:"))
          data += (data ? "\n" : "") + line.slice(5).trimStart();
      }
      if (event && !streamError) {
        try {
          dispatch(event, data);
        } catch {
          /* malformed frame — keep reading */
        }
      }
    }
  }
  clearInterval(watchdog);
  if (streamError) throw streamError;
  if (result === undefined) {
    throw new ApiError(500, "INCOMPLETE_STREAM", "stream ended without a result");
  }
  return result;
}

export interface RuntimeModel {
  id: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  isDefault?: boolean;
}

export interface AppSettings {
  model: string | null;
  reasoningEffort: "low" | "medium" | "high" | null;
  taskMode: "app-server" | "exec";
  /** v0.4: which question sources feed interviews. */
  questionSources?: {
    companyPacks: boolean;
    rolePacks: boolean;
    userBank: boolean;
    plugins: string[];
  };
  /** v0.4: voice mode (interaction layer only). */
  voice?: {
    enabled: boolean;
    speakQuestions: boolean;
  };
}

// --- v0.4 MCP ----------------------------------------------------------------

export interface McpServerInfo {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  /** Env var NAMES only — values never leave the server process. */
  envPassthrough: string[];
  enabled: boolean;
  allowedTools: string[];
}

export interface McpServersView {
  servers: McpServerInfo[];
  loadError: string | null;
}

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface ExternalContext {
  id: string;
  serverId: string;
  tool: string;
  title: string;
  text: string;
  createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the Interview OS server.");
  }
  const body = (await res.json().catch(() => null)) as
    | ({ error?: { code?: string; message?: string } } & Record<string, unknown>)
    | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return body as T;
}

export const api = {
  health: () => request<{ status: string; version: string }>("/api/health"),
  state: () => request<AppState>("/api/state"),
  readiness: () => request<ReadinessGraph>("/api/readiness"),
  skillDetail: (skillId: string) =>
    request<SkillDetail>(`/api/readiness/${encodeURIComponent(skillId)}`),
  runtimeStatus: () => request<RuntimeStatus>("/api/runtime/status"),
  runtimeCheck: () =>
    request<RuntimeStatus>("/api/runtime/check", { method: "POST" }),
  runtimeAvailable: () => request<RuntimeAvailability>("/api/runtime/available"),
  switchRuntime: (kind: string) =>
    request<RuntimeStatus>("/api/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    }),
  runtimeModels: () => request<RuntimeModel[]>("/api/runtime/models"),
  settings: () => request<AppSettings>("/api/settings"),
  saveSettings: (body: Partial<AppSettings>) =>
    request<AppSettings>("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  examples: () => request<string[]>("/api/examples"),
  example: (name: string) => request<ExampleMeta>(`/api/examples/${name}`),
  setup: (body: {
    resumeText: string;
    jobDescription: string;
    company: string;
    role: string;
    level: string;
    companyNotes?: string;
  }) =>
    request<SetupResult>("/api/workspace/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  preparation: () =>
    request<{ nextActions: PrepActionView[]; actions: PrepActionView[] }>("/api/preparation"),
  recalculatePlan: () =>
    request<PrepActionView[]>("/api/preparation/recalculate", { method: "POST" }),
  updateAction: (id: string, status: "open" | "in_progress" | "done" | "superseded") =>
    request<{ ok: boolean }>(`/api/preparation/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),
  completeAction: (id: string, checkedCriteria: string[]) =>
    request<{ ok: boolean; evidenceId: string | null; actions: PrepActionView[] }>(
      `/api/preparation/${id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkedCriteria }),
      },
    ),
  listTargets: () => request<TargetListItem[]>("/api/targets"),
  workspaceSources: () => request<WorkspaceSources>("/api/workspace/sources"),
  addTarget: (body: {
    jobDescription: string;
    company: string;
    role: string;
    level: string;
    companyNotes?: string;
  }) =>
    request<{ target: TargetRole; actions: PrepActionView[] }>("/api/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  activateTarget: (id: string) =>
    request<{ target: TargetRole; actions: PrepActionView[] }>(
      `/api/targets/${id}/activate`,
      { method: "POST" },
    ),
  companies: () => request<CompanyProfileInfo[]>("/api/companies"),
  updateTargetProfile: (id: string, companyProfileId: string) =>
    request<{ target: TargetRole }>(`/api/targets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyProfileId }),
    }),
  extractDocument: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ExtractResult>("/api/documents/extract", {
      method: "POST",
      body: form,
    });
  },
  startInterview: (
    opts: {
      plannedQuestions?: number;
      mode?: "interview" | "practice";
      focusSkillId?: string;
      actionId?: string;
      roundType?: RoundType;
      contextId?: string;
      pluginModeId?: string;
    } = {},
  ) =>
    request<StartInterviewResult>("/api/interviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plannedQuestions: 4, ...opts }),
    }),
  listInterviews: () => request<InterviewListItem[]>("/api/interviews"),
  /** v1: interview modes available for new sessions. */
  modes: () => request<{ modes: AvailableMode[] }>("/api/modes"),
  interview: (id: string) => request<SessionDetail>(`/api/interviews/${id}`),
  submitAnswer: (
    sessionId: string,
    body: { answer: string; code?: string; language?: string; voice?: VoiceMetrics },
  ) =>
    request<SubmitAnswerResult>(`/api/interviews/${sessionId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  nextQuestion: (sessionId: string) =>
    request<StartInterviewResult>(`/api/interviews/${sessionId}/next`, { method: "POST" }),
  completeInterview: (sessionId: string) =>
    request<CompleteInterviewResult>(
      `/api/interviews/${sessionId}/complete`,
      { method: "POST" },
    ),
  startLoop: (rounds?: { mode: RoundType; label?: string; plannedQuestions?: number }[]) =>
    request<StartLoopResult>("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rounds ? { rounds } : {}),
    }),
  loops: () => request<InterviewLoop[]>("/api/loops"),
  loop: (id: string) => request<InterviewLoop>(`/api/loops/${id}`),
  abandonLoop: (id: string) =>
    request<InterviewLoop>(`/api/loops/${id}/abandon`, { method: "POST" }),
  history: (filters: {
    mode?: string;
    targetId?: string;
    loopId?: string;
    weakOnly?: boolean;
  } = {}) => {
    const params = new URLSearchParams();
    if (filters.mode) params.set("mode", filters.mode);
    if (filters.targetId) params.set("targetId", filters.targetId);
    if (filters.loopId) params.set("loopId", filters.loopId);
    if (filters.weakOnly) params.set("weakOnly", "1");
    const qs = params.toString();
    return request<HistoryEntry[]>(`/api/history${qs ? `?${qs}` : ""}`);
  },
  sessionHistory: (id: string) => request<HistoryEntry>(`/api/history/${id}`),
  recordEvent: (event: string) =>
    request<{ ok: boolean }>("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    }),
  metrics: () => request<Metrics>("/api/metrics"),
  debrief: (sessionId: string) => request<Debrief>(`/api/interviews/${sessionId}/debrief`),
  stories: () => request<StarStory[]>("/api/stories"),
  updateStory: (id: string, patch: Partial<Omit<StarStory, "id" | "candidateId" | "source" | "updatedAt">>) =>
    request<StarStory>(`/api/stories/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  reviewResume: (handlers: StreamHandlers<ResumeReview> = {}) =>
    streamPost<ResumeReview>("/api/resume/review", {}, handlers),
  latestResumeReview: () =>
    request<ResumeReview | null>("/api/resume/reviews/latest"),
  skills: () => request<SkillsList>("/api/skills"),
  plugins: () => request<{ plugins: PluginView[] }>("/api/plugins"),
  setPluginEnabled: (id: string, enabled: boolean, grantedPermissions?: string[]) =>
    request<{ plugin: PluginView }>(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, grantedPermissions }),
    }),
  installPlugin: (url: string) =>
    request<{ plugin: PluginView }>("/api/plugins/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  uninstallPlugin: (id: string) =>
    request<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  runPlugin: (id: string) =>
    request<PluginRunResult>(`/api/plugins/${encodeURIComponent(id)}/run`, {
      method: "POST",
    }),
  /** v0.4: enabled plugins' UI contributions (nav, commands, slots, pages, modes). */
  uiContributions: () =>
    request<{ contributions: PluginUIContributionView[] }>("/api/ui/contributions"),
  /** v0.4: render a declared declarative contribution → validated UI tree. */
  renderPluginUI: (
    id: string,
    body: {
      slot?: string;
      component: string;
      page?: string;
      params?: unknown;
    },
  ) =>
    request<{ ui: UINode }>(`/api/plugins/${encodeURIComponent(id)}/ui/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** v0.4 Level 2: a frame's declared + granted data slices. */
  pluginUIData: (
    id: string,
    body: { component?: string; page?: string },
  ) =>
    request<{ slices: Record<string, unknown> }>(
      `/api/plugins/${encodeURIComponent(id)}/ui/data`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  /** v0.4 Level 2: stateless plugin invocation from inside a frame. */
  pluginUIRun: (
    id: string,
    body: { component?: string; page?: string; request?: Record<string, unknown> },
  ) =>
    request<{ output: unknown; ui?: UINode }>(
      `/api/plugins/${encodeURIComponent(id)}/ui/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  /** v1: plugin-declared settings fields + effective values. */
  pluginSettings: (id: string) =>
    request<{ fields: PluginSettingField[]; values: Record<string, unknown> }>(
      `/api/plugins/${encodeURIComponent(id)}/settings`,
    ),
  setPluginSettings: (id: string, values: Record<string, unknown>) =>
    request<{ values: Record<string, unknown> }>(
      `/api/plugins/${encodeURIComponent(id)}/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      },
    ),
  /** v1: plugin-suggested prep activities (read-only). */
  pluginPrepSuggestions: () =>
    request<{ suggestions: PluginSuggestionGroup[] }>(
      "/api/preparation/suggestions",
    ),
  acceptPluginSuggestion: (pluginId: string, activity: unknown) =>
    request<{ id: string }>("/api/preparation/suggestions/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId, activity }),
    }),
  packs: () => request<PackListView>("/api/packs"),
  installPack: (kind: "company" | "role", url: string) =>
    request<unknown>("/api/packs/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, url }),
    }),
  uninstallPack: (kind: "company" | "role", id: string) =>
    request<{ ok: boolean }>(
      `/api/packs/${kind}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  setTargetRolePack: (targetId: string, rolePackId: string | null) =>
    request<{ target: TargetRole }>(
      `/api/targets/${targetId}/role-pack`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rolePackId }),
      },
    ),
  interviewPacks: () => request<InterviewPackInfo[]>("/api/interview-packs"),
  createInterviewPack: (body: InterviewPackInput) =>
    request<InterviewPackInfo>("/api/interview-packs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  importInterviewPack: (content: string) =>
    request<InterviewPackInfo>("/api/interview-packs/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  deleteInterviewPack: (id: string) =>
    request<{ ok: boolean }>(
      `/api/interview-packs/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  exportInterviewPackUrl: (id: string) =>
    `/api/interview-packs/${encodeURIComponent(id)}/export`,
  startInterviewPack: (id: string) =>
    request<StartLoopResult>(
      `/api/interview-packs/${encodeURIComponent(id)}/start`,
      { method: "POST" },
    ),
  questionBank: () => request<UserBankQuestion[]>("/api/question-bank"),
  addBankQuestion: (body: {
    skillId: string;
    text: string;
    difficulty?: "easy" | "medium" | "hard";
    mode?: RoundType;
  }) =>
    request<unknown>("/api/question-bank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteBankQuestion: (id: string) =>
    request<{ ok: boolean }>(
      `/api/question-bank/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  importQuestionBank: (content: string) =>
    request<{ imported: number }>("/api/question-bank/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  fetchActionResources: (actionId: string) =>
    request<PrepActionView>(
      `/api/preparation/${encodeURIComponent(actionId)}/resources`,
      { method: "POST" },
    ),
  // ------------------------------------------------------------- v0.4 MCP
  mcpServers: () => request<McpServersView>("/api/mcp/servers"),
  updateMcpServer: (id: string, patch: { enabled?: boolean; allowedTools?: string[] }) =>
    request<McpServerInfo>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  mcpTools: (id: string) =>
    request<{ tools: McpToolInfo[] }>(`/api/mcp/servers/${encodeURIComponent(id)}/tools`),
  mcpContexts: () => request<ExternalContext[]>("/api/mcp/contexts"),
  fetchMcpContext: (body: {
    serverId: string;
    tool: string;
    args?: Record<string, unknown>;
    title?: string;
  }) =>
    request<ExternalContext>("/api/mcp/contexts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteMcpContext: (id: string) =>
    request<{ ok: boolean }>(`/api/mcp/contexts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  // ------------------------------------------------------ v0.4 export/import
  exportUrl: () => "/api/export",
  exportPartUrl: (part: string) => `/api/export/${encodeURIComponent(part)}`,
  importState: (bundle: unknown) =>
    request<{ ok: boolean; counts: Record<string, number> }>("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle, confirm: "replace" }),
    }),
};
