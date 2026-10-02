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

export interface SessionRow {
  id: string;
  candidateId: string | null;
  targetId: string | null;
  status: string;
  currentRound: number;
  plannedQuestions: number;
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
  questions: number;
  debrief: Debrief | null;
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
  mode: "codex" | "mock";
}

export interface ExampleMeta {
  name: string;
  resumeText: string;
  jobDescription: string;
  company: string;
  role: string;
  level: string;
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
  examples: () => request<string[]>("/api/examples"),
  example: (name: string) => request<ExampleMeta>(`/api/examples/${name}`),
  setup: (body: {
    resumeText: string;
    jobDescription: string;
    company: string;
    role: string;
    level: string;
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
  startInterview: (plannedQuestions = 4) =>
    request<StartInterviewResult>("/api/interviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plannedQuestions }),
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
};
