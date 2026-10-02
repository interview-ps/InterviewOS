import type {
  CandidateProfile,
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

export type RoundType = "mixed" | "technical" | "system_design" | "behavioral" | "hr";

export interface SessionRow {
  id: string;
  candidateId: string | null;
  targetId: string | null;
  status: string;
  currentRound: number;
  plannedQuestions: number;
  mode: "interview" | "practice";
  roundType: RoundType;
  focusSkillId: string | null;
  actionId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SessionQuestion extends Question {
  selectionReason: string | null;
  selectionPriority: number | null;
}

export interface AnswerRow {
  id: string;
  questionId: string;
  sessionId: string;
  text: string;
  status: string;
  createdAt: string;
}

export interface DimensionScore {
  score: number;
  rationale: string;
}

export interface Evaluation {
  summary: string;
  dimensions: Record<string, DimensionScore>;
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
}

export interface InterviewListItem extends SessionRow {
  target: { id: string; role: string; company: string } | null;
  questions: number;
  debrief: Debrief | null;
}

export interface CompanyProfile {
  values: string[];
  interviewStyle: string;
  focusSkillIds: string[];
  behavioralThemes: string[];
}

export interface TargetListItem {
  id: string;
  company: string;
  role: string;
  level: string;
  active: boolean;
  createdAt: string;
  companyProfile: CompanyProfile | null;
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
  mode: "codex" | "mock" | "claude" | "opencode";
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
    const { done, value } = await reader.read();
    if (done) break;
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
  submitAnswer: (sessionId: string, answer: string) =>
    request<SubmitAnswerResult>(`/api/interviews/${sessionId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    }),
  nextQuestion: (sessionId: string) =>
    request<StartInterviewResult>(`/api/interviews/${sessionId}/next`, { method: "POST" }),
  completeInterview: (sessionId: string) =>
    request<{ session: SessionRow; debrief: Debrief }>(
      `/api/interviews/${sessionId}/complete`,
      { method: "POST" },
    ),
  debrief: (sessionId: string) => request<Debrief>(`/api/interviews/${sessionId}/debrief`),
  stories: () => request<StarStory[]>("/api/stories"),
  updateStory: (id: string, patch: Partial<Omit<StarStory, "id" | "candidateId" | "source" | "updatedAt">>) =>
    request<StarStory>(`/api/stories/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
};
