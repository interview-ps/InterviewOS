import type {
  CandidateProfile,
  CompanyNotesProfile,
  CompanyProfile,
  Evidence,
  Gap,
  InterviewOSState,
  PrepAction,
  Question,
  ReadinessGraph,
  SkillReadiness,
  TargetRole,
} from "@interview-os/core";

export type AppState = InterviewOSState;
export type { CandidateProfile, Gap, PrepAction, Question, SkillReadiness, Evidence, TargetRole };

export interface ExpectedConcept {
  concept: string;
  skillId: string;
  keywords: string[];
}

export type RoundType =
  | "mixed"
  | "technical"
  | "coding"
  | "system_design"
  | "behavioral"
  | "hiring_manager"
  | "hr";

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
  modeState: Record<string, unknown>;
  focusSkillId: string | null;
  actionId: string | null;
  /** §9.4: set when this session is a loop round (1-based). */
  loopId: string | null;
  loopRound: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SelectionFactors {
  roleImportance: number;
  readinessGap: number;
  uncertainty: number;
  weaknessBoost: number;
  recencyFactor: number;
  noveltyFactor: number;
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
}

export interface AnswerRow {
  id: string;
  questionId: string;
  sessionId: string;
  text: string;
  code: string | null;
  language: string | null;
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
  newActions: PrepAction[];
  nextAvailable: "question" | "complete";
}

export interface SkillDetail {
  skillId: string;
  readiness: SkillReadiness | null;
  evidence: (Evidence & { sessionId: string | null; questionId: string | null })[];
  history: { id: number; score: number | null; confidence: number; computedAt: string; reason: string }[];
  actions: PrepAction[];
  recommendedAction: PrepAction | null;
}

export interface RuntimeStatus {
  runtime: string;
  available: boolean;
  version?: string;
  executable?: string;
  workspace?: string;
  status: string;
  message?: string;
  mode: "codex" | "mock" | "claude" | "opencode" | "devin";
}

export interface RuntimeProbe {
  runtime: string;
  available: boolean;
  version?: string;
  executable?: string;
  workspace?: string;
  status: string;
  message?: string;
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
  actions: PrepAction[];
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
  actionsCreated: PrepAction[];
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
    // rather than waiting for stream close: the Next.js rewrite proxy
    // intermittently holds the final bytes of a long-lived SSE response.
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
    request<{ nextActions: PrepAction[]; actions: PrepAction[] }>("/api/preparation"),
  recalculatePlan: () =>
    request<PrepAction[]>("/api/preparation/recalculate", { method: "POST" }),
  updateAction: (id: string, status: "open" | "in_progress" | "done" | "superseded") =>
    request<{ ok: boolean }>(`/api/preparation/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),
  completeAction: (id: string, checkedCriteria: string[]) =>
    request<{ ok: boolean; evidenceId: string | null; actions: PrepAction[] }>(
      `/api/preparation/${id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkedCriteria }),
      },
    ),
  listTargets: () => request<TargetListItem[]>("/api/targets"),
  addTarget: (body: {
    jobDescription: string;
    company: string;
    role: string;
    level: string;
    companyNotes?: string;
  }) =>
    request<{ target: TargetRole; actions: PrepAction[] }>("/api/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  activateTarget: (id: string) =>
    request<{ target: TargetRole; actions: PrepAction[] }>(
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
    } = {},
  ) =>
    request<StartInterviewResult>("/api/interviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plannedQuestions: 4, ...opts }),
    }),
  listInterviews: () => request<InterviewListItem[]>("/api/interviews"),
  interview: (id: string) => request<SessionDetail>(`/api/interviews/${id}`),
  submitAnswer: (sessionId: string, body: { answer: string; code?: string; language?: string }) =>
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
  runPlugin: (id: string) =>
    request<{ output: unknown }>(`/api/plugins/${encodeURIComponent(id)}/run`, {
      method: "POST",
    }),
};
