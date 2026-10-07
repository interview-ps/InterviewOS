import { Link, useNavigate, useParams } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { VOICE_DISCLAIMER } from "@interview-os/frontend-types";
import {
  api,
  streamPost,
  type AIUsageSummary,
  type AnswerRow,
  type Debrief,
  type Evaluation,
  type InterviewLoop,
  type SessionDetail,
  type SessionQuestion,
  type SessionRow,
  type StartInterviewResult,
  type SubmitAnswerResult,
  type VoiceFeedback,
} from "@/lib/api";
import { speechSupported, useSpeakQuestion, useVoiceCapture } from "@/lib/voice";
import {
  Bar,
  Button,
  DeltaList,
  ErrorNote,
  EvidenceTimeline,
  Panel,
  Pill,
  RichText,
  ScreenToolbar,
  SkeletonCard,
  SplitPane,
  Workspace,
  displayLabel,
  severityTone,
  skillLabel,
  type Tone,
} from "@/components/ui";
import { useSetPageTitle } from "@/lib/page-title";
import { commandEnterLabel } from "@/lib/platform";
import { useAppRefreshEffect } from "@/lib/app-refresh";
import {
  PluginModeSlot,
  PluginSlot,
  useModeSlotHasContent,
} from "@/components/plugin-ui";

const CODE_LANGUAGES = [
  "python", "javascript", "typescript", "java", "go", "cpp", "csharp",
  "ruby", "rust", "kotlin", "swift", "sql", "other",
];

/** An in-progress answer persisted locally so a reload doesn't lose it. */
type AnswerDraft = {
  answer: string;
  code: string;
  language?: string;
  fields?: Record<string, string | number>;
};

const DRAFT_KEY_PREFIX = "interview-os:draft:";

function draftStorageKey(sessionId: string, questionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}:${questionId}`;
}

function readDraft(key: string): AnswerDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AnswerDraft>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      answer: typeof parsed.answer === "string" ? parsed.answer : "",
      code: typeof parsed.code === "string" ? parsed.code : "",
      language: typeof parsed.language === "string" ? parsed.language : undefined,
      fields:
        parsed.fields && typeof parsed.fields === "object" ? parsed.fields : undefined,
    };
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: AnswerDraft): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    /* storage unavailable — the draft stays in memory only */
  }
}

function removeDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

type EvalTab = "feedback" | "rubric" | "answer" | "evidence";
type EvalEvidence = Awaited<ReturnType<typeof api.skillDetail>>["evidence"][number];

/** Live text streamed from the model while a long AI step runs (§8.3). */
function StreamDraft({
  stage,
  draft,
}: {
  stage: string | null;
  draft: { field: string; text: string } | null;
}) {
  if (!draft || draft.text.length === 0) return null;
  return (
    <p className="mt-2 rounded-[var(--radius-sm)] bg-page p-2 text-[13px] text-muted" aria-live="polite">
      {stage && (
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-blue">
          {stage}…
        </span>
      )}
      {draft.text}
      <span aria-hidden>▌</span>
    </p>
  );
}

/** v0.4: where a question came from (generated questions show nothing). */
function SourceBadge({ source }: { source: SessionQuestion["source"] }) {
  if (!source) return null;
  const label =
    source.kind === "user_bank"
      ? "From your question bank"
      : source.kind === "company_pack"
        ? `Company pack: ${source.id}`
        : source.kind === "role_pack"
          ? `Role pack: ${source.id}`
          : `Plugin: ${source.id}`;
  return (
    <>
      <Pill tone="green">{label}</Pill>
      {source.provenance === "community" && <Pill tone="amber">community</Pill>}
    </>
  );
}

/** v0.4: delivery hints from voice metrics — interaction layer only. */
function DeliveryHints({ feedback }: { feedback: VoiceFeedback }) {
  return (
    <div data-testid="delivery-hints" className="rounded-[var(--radius-sm)] border border-line bg-page p-2.5">
      <h3 className="text-[13px] font-semibold text-navy">Delivery hints</h3>
      <ul className="mt-1.5 space-y-1">
        {feedback.signals.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-[13px]">
            <Pill tone={s.status === "ok" ? "green" : "amber"}>{s.status}</Pill>
            <span className="text-muted">{s.message}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted">
        {feedback.wordCount} words
        {feedback.wordsPerMinute != null && ` · ${Math.round(feedback.wordsPerMinute)} wpm`}
        {feedback.fillerCount > 0 && ` · ${feedback.fillerCount} fillers`}
      </p>
      <p className="mt-1 text-xs text-muted">{VOICE_DISCLAIMER}</p>
    </div>
  );
}

/** §9.2: "Why this question" in plain language, with the scoring detail nested. */
function WhyThisQuestion({ q }: { q: SessionQuestion }) {
  if (!q.selectionReason && !q.selectionFactors) return null;
  const f = q.selectionFactors;
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer">Why this question</summary>
      {q.selectionReason && <p className="mt-1">{q.selectionReason}</p>}
      {f && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[0.7rem]">Show scoring detail</summary>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
            {(
              [
                ["role importance", f.roleImportance],
                ["readiness gap", f.readinessGap],
                ["uncertainty", f.uncertainty],
                ["weakness boost", f.weaknessBoost],
                ["recency", f.recencyFactor],
                ["novelty", f.noveltyFactor],
              ] as const
            ).map(([name, v]) => (
              <div key={name} className="flex justify-between gap-2">
                <dt>{name}</dt>
                <dd className="font-mono text-ink">{v.toFixed(2)}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-2">
              <dt>priority</dt>
              <dd className="font-mono text-ink">{q.selectionPriority?.toFixed(2) ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>difficulty</dt>
              <dd className="font-mono text-ink">{q.difficulty}</dd>
            </div>
          </dl>
        </details>
      )}
    </details>
  );
}

/**
 * The interviewer's question. A soft brand-tinted, opaque surface with a brand
 * left edge marks "the system speaking" while keeping the one string that must
 * stay legible off any translucent glass (settled surfaces stay opaque).
 */
function InterviewerQuestion({ text }: { text: string }) {
  return (
    <div
      data-testid="interviewer-question"
      className="rounded-[var(--radius-sm)] border-s-[3px] border-s-[var(--color-blue)] bg-[var(--interview-selection)] px-3.5 py-3"
    >
      <p className="text-[15px] font-medium leading-relaxed">
        <RichText text={text} />
      </p>
    </div>
  );
}

/** One answered question in the transcript — the main question plus its follow-ups. */
interface Turn {
  question: SessionQuestion;
  answer: AnswerRow | null;
  evaluation: Evaluation | null;
}

interface MainTurn extends Turn {
  followUps: Turn[];
}

/** Headline for an evaluation — mean rubric when present, else mean skill score. */
function evaluationScore(evaluation: Evaluation): number | null {
  const values = evaluation.rubric.length
    ? evaluation.rubric.map((r) => r.score)
    : evaluation.scores.map((s) => s.score);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Score → tone by meaning: green once strong, blue developing, amber weak. */
function scoreTone(score: number | null): Tone {
  if (score === null) return "muted";
  if (score >= 0.75) return "green";
  if (score >= 0.5) return "blue";
  return "amber";
}

/** The candidate's submitted answer as a chat bubble. */
function AnswerBubble({ text, code }: { text: string; code?: string | null }) {
  if (!text.trim() && !code) return null;
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-[var(--radius-sm)] border border-divider bg-page px-3.5 py-3">
        {text.trim() && <p className="whitespace-pre-wrap text-sm">{text}</p>}
        {code && (
          <pre className="mt-2 overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--color-inset)] p-2.5 font-mono text-xs">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

/** A past answer's evaluation, collapsed to its headline score and summary. */
function EvaluationSummary({ evaluation }: { evaluation: Evaluation }) {
  const score = evaluationScore(evaluation);
  return (
    <details
      data-testid="eval-summary"
      className="rounded-[var(--radius-sm)] border border-divider bg-surface"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
        <Pill tone={scoreTone(score)}>
          {score === null ? "Evaluated" : `${Math.round(score * 100)}%`}
        </Pill>
        <span className="min-w-0 flex-1 truncate text-muted">{evaluation.summary}</span>
        <span className="shrink-0 text-xs text-muted">details</span>
      </summary>
      <div className="space-y-2.5 border-t border-divider px-3 py-2.5">
        {evaluation.summary && (
          <p className="text-[13px]">
            <RichText text={evaluation.summary} />
          </p>
        )}
        {evaluation.weaknesses.length > 0 && (
          <div>
            <h3 className="text-[13px] font-semibold text-accent">What was missing</h3>
            <ul className="mt-1 space-y-1 text-[13px] text-muted">
              {evaluation.weaknesses.map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Pill tone={severityTone(w.severity)}>{w.severity}</Pill>
                  <span>
                    <span className="font-medium text-ink">{skillLabel(w.skill)}</span> —{" "}
                    <RichText text={w.evidence} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {evaluation.strengths.length > 0 && (
          <div>
            <h3 className="text-[13px] font-semibold text-green">What went well</h3>
            <ul className="mt-1 list-disc space-y-0.5 ps-5 text-[13px] text-muted">
              {evaluation.strengths.map((s, i) => (
                <li key={i}>
                  <RichText text={s.evidence} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {evaluation.rubric.length > 0 && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Rubric</summary>
            <div className="mt-1.5">
              <RubricBars rubric={evaluation.rubric} />
            </div>
          </details>
        )}
      </div>
    </details>
  );
}

/** Mode rubric as compact aligned rows; weakest three show their rationale. */
function RubricBars({ rubric }: { rubric: { id: string; label: string; score: number; rationale: string }[] }) {
  if (rubric.length === 0) return null;
  const sorted = [...rubric].sort((a, b) => a.score - b.score);
  const weakest = new Set(sorted.slice(0, 3).map((r) => r.id));
  return (
    <div data-testid="rubric">
      <ul className="space-y-1.5">
        {sorted.map((r) => (
          <li key={r.id}>
            <div className="flex items-center gap-3 text-[13px]">
              <span className="w-44 truncate text-muted" title={r.id}>{r.label}</span>
              <div className="w-40 shrink-0"><Bar value={r.score} /></div>
              <span className="text-xs text-muted">{Math.round(r.score * 100)}%</span>
            </div>
            {weakest.has(r.id) && r.rationale && (
              <p className="mt-0.5 text-xs text-muted">{r.rationale}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** v1.1: declarative inputs for modes whose answerFormat is "fields". */
function AnswerFieldsEditor({
  fields,
  values,
  onChange,
}: {
  fields: NonNullable<SessionRow["answerFields"]>;
  values: Record<string, string | number>;
  onChange: (key: string, value: string | number | undefined) => void;
}) {
  return (
    <div className="space-y-3">
      {fields.map((f) => (
        <div key={f.key} data-testid={`answer-field-${f.key}`}>
          <label className="mb-1 block text-sm font-medium">
            {f.label}
            {f.required ? <span className="text-accent"> *</span> : null}
          </label>
          {f.type === "choice" ? (
            <select
              value={typeof values[f.key] === "string" ? String(values[f.key]) : ""}
              onChange={(e) => onChange(f.key, e.target.value || undefined)}
              aria-label={f.label}
              className="w-full rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1.5 text-sm"
            >
              <option value="">Choose…</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : f.type === "number" ? (
            <input
              type="number"
              value={values[f.key] ?? ""}
              onChange={(e) =>
                onChange(
                  f.key,
                  e.target.value === "" ? undefined : Number(e.target.value),
                )
              }
              aria-label={f.label}
              className="w-full rounded-[var(--radius-sm)] border border-line p-2 text-sm"
            />
          ) : (
            <textarea
              value={typeof values[f.key] === "string" ? String(values[f.key]) : ""}
              onChange={(e) => onChange(f.key, e.target.value)}
              rows={f.type === "code" ? 9 : 4}
              spellCheck={f.type !== "code"}
              placeholder={f.type === "code" ? "Paste or write code — reviewed, not executed." : "Type your answer…"}
              aria-label={f.label}
              className={
                f.type === "code"
                  ? "w-full rounded-[var(--radius-sm)] border border-line bg-[var(--color-inset)] p-3 font-mono text-[13px] leading-relaxed"
                  : "w-full rounded-[var(--radius-sm)] border border-line p-2.5 leading-relaxed"
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}

export default function InterviewSession() {
  const id = useParams().id ?? "";
  const navigate = useNavigate();
  const [detail, setDetail] = useState<SessionDetail | null>(null);

  // Descriptive breadcrumb name instead of the session id (D2).
  useSetPageTitle(
    detail
      ? `${detail.session.modeLabel ?? displayLabel(detail.session.roundType)} interview · ${new Date(detail.session.createdAt).toLocaleDateString()}`
      : null,
  );
  const [current, setCurrent] = useState<SessionQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string | number>>({});
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("python");
  const [result, setResult] = useState<SubmitAnswerResult | null>(null);
  const [debrief, setDebrief] = useState<Debrief | null>(null);
  const [loop, setLoop] = useState<InterviewLoop | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ field: string; text: string } | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const [evalTab, setEvalTab] = useState<EvalTab>("feedback");
  const [evalEvidence, setEvalEvidence] = useState<EvalEvidence[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [usage, setUsage] = useState<AIUsageSummary | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const restoredDraftRef = useRef<string | null>(null);
  const draftKey = current ? draftStorageKey(id, current.id) : null;
  const voice = useVoiceCapture(
    useCallback(
      (t: string) => setAnswer((a) => (a.trim() ? `${a.trimEnd()} ${t.trim()}` : t.trim())),
      [],
    ),
  );

  const load = useCallback(async () => {
    const d = await api.interview(id);
    setDetail(d);
    if (d.debrief) setDebrief(d.debrief);
    if (d.session.loopId) {
      setLoop(await api.loop(d.session.loopId).catch(() => null));
    }
    const answered = new Set(d.answers.map((a) => a.questionId));
    const pending =
      d.questions.find((q) => !q.followUpOf && !answered.has(q.id)) ??
      d.questions.find((q) => !answered.has(q.id)) ??
      null;
    setCurrent(pending);
    return { d, pending };
  }, [id]);

  /** Re-read the session without touching the active question — grows the transcript. */
  const refreshDetail = useCallback(async () => {
    const d = await api.interview(id);
    setDetail(d);
    if (d.debrief) setDebrief(d.debrief);
  }, [id]);

  useEffect(() => {
    load().catch((e) => setError(e));
    api
      .settings()
      .then((s) => {
        setVoiceOn(!!s.voice?.enabled);
        setSpeakOn(!!s.voice?.enabled && (s.voice?.speakQuestions ?? true));
      })
      .catch(() => {});
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  useSpeakQuestion(speakOn && voice.supported, current?.text ?? null);

  // This session's AI cost + context fill (refreshed after each turn).
  const loadUsage = useCallback(() => {
    api.aiUsage({ session: id }).then(setUsage).catch(() => setUsage(null));
  }, [id]);

  useEffect(() => {
    loadUsage();
  }, [loadUsage, detail, result]);

  // The answer result carries readiness deltas, not the evidence itself — load
  // the newly recorded evidence for the affected skills when the tab opens.
  useEffect(() => {
    if (evalTab !== "evidence" || !result) return;
    const skillIds = Array.from(new Set(result.skillImpact.map((s) => s.skillId)));
    if (skillIds.length === 0) {
      setEvalEvidence([]);
      return;
    }
    let cancelled = false;
    Promise.all(skillIds.map((sid) => api.skillDetail(sid).catch(() => null)))
      .then((details) => {
        if (cancelled) return;
        const items = details
          .flatMap((d) => d?.evidence ?? [])
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        setEvalEvidence(items.slice(0, 8));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [evalTab, result]);

  // The transcript: every answered question (mains with their follow-ups), the
  // submitted answer, and its evaluation. Answers and evaluations are persisted
  // one-to-one in order, so pair them by index (evaluations carry no question id).
  const transcript = useMemo<MainTurn[]>(() => {
    if (!detail) return [];
    const answerByQuestion = new Map(detail.answers.map((a) => [a.questionId, a]));
    const evaluationByAnswer = new Map<string, Evaluation>();
    detail.answers
      .filter((a) => a.status === "evaluated")
      .forEach((answer, i) => {
        const evaluation = detail.evaluations[i];
        if (evaluation) evaluationByAnswer.set(answer.id, evaluation);
      });
    const turnFor = (q: SessionQuestion): Turn => {
      const answer = answerByQuestion.get(q.id) ?? null;
      return {
        question: q,
        answer,
        evaluation: answer ? evaluationByAnswer.get(answer.id) ?? null : null,
      };
    };
    return detail.questions
      .filter((q) => !q.followUpOf)
      .map((main) => ({
        ...turnFor(main),
        followUps: detail.questions.filter((f) => f.followUpOf === main.id).map(turnFor),
      }))
      .filter((t) => t.answer !== null || t.followUps.some((f) => f.answer !== null));
  }, [detail]);

  // Keep the newest turn (and its evaluation) in view as the transcript grows.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length, result, current?.id]);

  const modeId = detail?.session.roundType ?? "";
  const hasInspector = useModeSlotHasContent("interview.sidebar", modeId);
  const hasQuestionPanel = useModeSlotHasContent("interview.question", modeId);

  const tick = () => {
    setElapsed(0);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  };
  const untick = () => { if (timer.current) clearInterval(timer.current); };

  const progress = {
    onStage: (name: string) => setStage(name),
    onDelta: (field: string, text: string) => setDraft({ field, text }),
  };

  // v1: code editor shows for "text+code"; v1.1: "fields" renders the mode's
  // declared widgets instead of the free-text box.
  const acceptsCode = detail?.session.answerFormat === "text+code";
  const fieldsMode = detail?.session.answerFormat === "fields";
  const answerFields = detail?.session.answerFields ?? [];
  const missingRequired = answerFields.some(
    (f) => f.required && !(f.key in fieldValues && fieldValues[f.key] !== ""),
  );
  const submitDisabled = busy || (fieldsMode ? missingRequired : !answer.trim());

  const submit = () => {
    setBusy(true);
    setError(null);
    setStage(null);
    setDraft(null);
    tick();
    const voiceMetrics = voice.takeMetrics();
    const body = fieldsMode
      ? { answer: "", fields: fieldValues, ...(voiceMetrics ? { voice: voiceMetrics } : {}) }
      : acceptsCode
        ? { answer, ...(code.trim() ? { code, language } : {}), ...(voiceMetrics ? { voice: voiceMetrics } : {}) }
        : { answer, ...(voiceMetrics ? { voice: voiceMetrics } : {}) };
    streamPost<SubmitAnswerResult>(`/api/interviews/${id}/answer`, body, progress)
      .then((r) => {
        setResult(r);
        setEvalTab("feedback");
        setDraft(null);
        if (draftKey) removeDraft(draftKey);
      })
      .catch((e) => setError(e))
      .finally(() => { setBusy(false); untick(); });
  };

  const next = () => {
    setBusy(true);
    setError(null);
    setStage(null);
    setDraft(null);
    streamPost<StartInterviewResult>(`/api/interviews/${id}/next`, {}, progress)
      .then(async (r) => {
        setAnswer("");
        setFieldValues({});
        setCode("");
        setResult(null);
        setDraft(null);
        if (r.question) {
          setCurrent(r.question);
          await refreshDetail().catch(() => {});
        } else {
          await load();
        }
      })
      .catch(async (e) => {
        setError(e);
        await load().catch(() => {});
      })
      .finally(() => setBusy(false));
  };

  const finish = () => {
    setBusy(true);
    setStage(null);
    setDraft(null);
    streamPost<{ session: SessionDetail["session"]; debrief: Debrief }>(
      `/api/interviews/${id}/complete`,
      {},
      progress,
    )
      .then((r) => { setDebrief(r.debrief); setDraft(null); return load(); })
      .catch(async () => {
        const d = await api.debrief(id).catch(() => null);
        if (d) setDebrief(d);
        await load().catch(() => {});
      })
      .finally(() => setBusy(false));
  };

  /** Turn a fresh prep action straight into practice — feedback becomes work. */
  const practiceAction = (a: { id: string; skillId: string }) => {
    setBusy(true);
    api
      .startInterview({ mode: "practice", focusSkillId: a.skillId, actionId: a.id })
      .then((r) => r.session && navigate(`/interview/${r.session.id}`))
      .catch((e) => setError(e))
      .finally(() => setBusy(false));
  };

  const done = debrief !== null;
  const discarded = detail?.session.abandoned ?? false;
  const answering = !done && !discarded && result === null && current !== null;

  // Ctrl/Cmd+Enter submits from anywhere on the page (the hint sits by the button).
  const submitRef = useRef<() => void>(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    if (!answering) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (!submitDisabled) submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answering, submitDisabled]);

  // Restore a saved draft when the active question changes.
  useEffect(() => {
    if (!draftKey || restoredDraftRef.current === draftKey) return;
    restoredDraftRef.current = draftKey;
    const saved = readDraft(draftKey);
    if (!saved) return;
    setAnswer(saved.answer);
    setCode(saved.code);
    if (saved.language) setLanguage(saved.language);
    if (saved.fields) setFieldValues(saved.fields);
  }, [draftKey]);

  // Debounced autosave (500 ms). Nothing is persisted once the answer is submitted.
  useEffect(() => {
    if (!draftKey || result) return;
    const hasContent =
      answer.trim().length > 0 ||
      code.trim().length > 0 ||
      Object.keys(fieldValues).length > 0;
    const debounce = setTimeout(() => {
      if (hasContent) writeDraft(draftKey, { answer, code, language, fields: fieldValues });
      else removeDraft(draftKey);
    }, 500);
    return () => clearTimeout(debounce);
  }, [draftKey, result, answer, code, language, fieldValues]);

  // Warn before leaving with an unsubmitted draft (contents are never logged).
  const hasDraftContent =
    answer.trim().length > 0 ||
    code.trim().length > 0 ||
    Object.keys(fieldValues).length > 0;
  useEffect(() => {
    if (result || !hasDraftContent) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [result, hasDraftContent]);

  // Refetch the session when the shell broadcasts a refresh (e.g. target switch).
  useAppRefreshEffect(() => {
    void refreshDetail().catch(() => {});
  });

  if (!detail && !error) {
    return (
      <Workspace toolbar={<ScreenToolbar title="Interview" />} bodyClassName="space-y-3">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={4} />
      </Workspace>
    );
  }

  const usageCost = (usage?.totals.cost ?? [])
    .map((entry) => `${entry.amount.toFixed(4)} ${entry.currency}`)
    .join(" · ");
  const contextUsed = usage?.latestContext?.used ?? null;
  const contextSize = usage?.latestContext?.size ?? null;
  const contextRatio = contextUsed !== null && contextSize ? contextUsed / contextSize : 0;
  const usageStrip =
    usage && usage.totals.turns > 0 && contextRatio > 0.8 ? (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>AI cost this session: {usageCost || "—"}</span>
        <Pill tone="amber">Context window {Math.round(contextRatio * 100)}% full</Pill>
      </div>
    ) : null;
  const round = detail ? Math.min(detail.session.currentRound, detail.session.plannedQuestions) : 0;
  const modeLabel = detail?.session.modeLabel ?? detail?.session.roundType.replace("_", " ");
  const focusDimension =
    typeof current?.extra?.focusDimension === "string" ? current.extra.focusDimension : null;

  const submitFooter = (
    <>
      <StreamDraft stage={stage} draft={draft} />
      <div className="flex items-center gap-3">
        <Button size="small" onClick={submit} loading={busy} disabled={submitDisabled}>
          Submit Answer
        </Button>
        <span className="text-xs text-muted" data-testid="submit-hint">
          {commandEnterLabel()} submits
        </span>
        {busy && (
          <span role="status" aria-live="polite" className="text-[13px] text-muted">
            {stage ? `${stage}…` : "Evaluating…"} {elapsed}s
          </span>
        )}
      </div>
      {submitDisabled && !busy && (
        <p className="mt-1 text-xs text-muted">
          {fieldsMode
            ? "Complete the required fields to submit."
            : "Add your approach to submit — code is optional and reviewed, not executed."}
        </p>
      )}
    </>
  );

  const questionMeta = current && (
    <div className="flex flex-wrap items-center gap-2">
      {/* When a mode panel already names the problem, don't repeat it as a pill. */}
      {!hasQuestionPanel && <Pill tone="muted">{current.topic}</Pill>}
      <Pill tone="muted">difficulty {current.difficulty}</Pill>
      {current.followUpOf && (
        <Pill tone="amber">
          Follow-up{current.followUpFocus ? `: ${current.followUpFocus}` : ""}
        </Pill>
      )}
      {focusDimension && <Pill tone="blue">focus: {focusDimension}</Pill>}
      <SourceBadge source={current.source} />
    </div>
  );

  const modeQuestionPanel = detail && current && (
    <PluginModeSlot
      slot="interview.question"
      modeId={detail.session.roundType}
      params={{ modeId: detail.session.roundType, extra: current.extra ?? {} }}
    />
  );

  const voiceControl = voiceOn && !fieldsMode && (
    <div className="flex items-center gap-2">
      {voice.supported ? (
        <>
          <Button variant="secondary" size="small" onClick={voice.toggle} data-testid="voice-toggle">
            {voice.recording ? "■ Stop speaking" : "● Speak answer"}
          </Button>
          {voice.recording && (
            <span className="text-xs text-muted" role="status">
              Recording — your words are appended to the answer; you can still type.
            </span>
          )}
        </>
      ) : (
        <p className="text-xs text-muted" data-testid="voice-unsupported">
          Voice capture isn't supported in this browser (Web Speech API — Chrome/Edge). Type your
          answer instead.
        </p>
      )}
    </div>
  );

  const renderAnswerTextarea = (grow: boolean, label?: string) => (
    <label className={`flex flex-col text-sm ${grow ? "min-h-0 flex-1" : ""}`}>
      <span className={label ? "mb-1 text-[13px] font-medium" : "sr-only"}>
        {label ?? "Your answer"}
      </span>
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={grow ? 8 : 4}
        placeholder={acceptsCode ? "Explain your approach…" : "Type your answer…"}
        className={`w-full resize-none rounded-[var(--radius-sm)] border border-line p-2.5 leading-relaxed ${
          grow ? "min-h-0 flex-1" : ""
        }`}
      />
    </label>
  );

  const codeEditor = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] font-medium">Code</span>
        <label className="flex items-center gap-2 text-xs text-muted">
          Language
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            aria-label="Code language"
            className="rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-0.5 text-xs"
          >
            {CODE_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      </div>
      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: t } = el;
            setCode(code.slice(0, s) + "  " + code.slice(t));
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
        }}
        spellCheck={false}
        placeholder="Paste or write your solution — reviewed, not executed."
        aria-label="Code answer"
        className="min-h-0 w-full flex-1 resize-none rounded-[var(--radius-sm)] border border-line bg-[var(--color-inset)] p-3 font-mono text-[13px] leading-relaxed"
      />
      <p className="mt-1 text-xs text-muted">Code is reviewed, not executed.</p>
    </div>
  );

  let running: ReactNode = null;
  if (!done && detail && current && !result) {
    if (fieldsMode) {
      running = (
        <Panel className="flex-1" footer={submitFooter} bodyClassName="space-y-3">
          {questionMeta}
          <WhyThisQuestion q={current} />
          <InterviewerQuestion text={current.text} />
          {modeQuestionPanel}
          <AnswerFieldsEditor
            fields={answerFields}
            values={fieldValues}
            onChange={(key, value) =>
              setFieldValues((v) => {
                const next = { ...v };
                if (value === undefined || value === "") delete next[key];
                else next[key] = value;
                return next;
              })
            }
          />
        </Panel>
      );
    } else if (acceptsCode) {
      running = (
        <SplitPane
          leftWidth="38%"
          className="flex-1"
          left={
            <Panel className="h-full" bodyClassName="space-y-2">
              {questionMeta}
              <WhyThisQuestion q={current} />
              <InterviewerQuestion text={current.text} />
              {modeQuestionPanel}
            </Panel>
          }
          right={
            <Panel className="h-full" footer={submitFooter} bodyClassName="flex min-h-0 flex-col gap-2">
              {renderAnswerTextarea(false, "Approach")}
              {codeEditor}
            </Panel>
          }
        />
      );
    } else {
      running = (
        <Panel className="flex-1" footer={submitFooter} bodyClassName="flex min-h-0 flex-col gap-3">
          <div className="shrink-0 space-y-2">
            {questionMeta}
            <WhyThisQuestion q={current} />
            <InterviewerQuestion text={current.text} />
            {modeQuestionPanel}
          </div>
          <div className="shrink-0">{voiceControl}</div>
          {renderAnswerTextarea(true)}
        </Panel>
      );
    }
  }

  const evalScores = result?.evaluation.scores ?? [];
  const answerScore = evalScores.length
    ? evalScores.reduce((a, s) => a + s.score, 0) / evalScores.length
    : null;
  const answerConfidence = evalScores.length
    ? evalScores.reduce((a, s) => a + s.confidence, 0) / evalScores.length
    : null;
  const rubricAvg =
    result && result.evaluation.rubric.length > 0
      ? result.evaluation.rubric.reduce((a, r) => a + r.score, 0) /
        result.evaluation.rubric.length
      : null;
  const readinessMoved = result
    ? result.skillImpact.filter(
        (s) => s.before !== null && s.after !== null && s.after > s.before,
      ).length
    : 0;

  const evaluationPanel = result && (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <header className="border-b border-line bg-[var(--color-inset)] px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="inline-flex h-5 items-center rounded-[var(--radius-xs)] bg-[var(--color-tint)] px-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-blue-hover)]">
            Evaluation
          </span>
          <span className="text-[22px] font-semibold leading-tight tabular-nums text-navy">
            {answerScore === null ? "—" : `${Math.round(answerScore * 100)}%`}
          </span>
          <span className="text-xs text-muted">answer score</span>
          <details className="ms-auto text-xs text-muted">
            <summary className="cursor-pointer select-none">details</summary>
            <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
              <div className="flex justify-between gap-2">
                <dt>confidence</dt>
                <dd className="font-mono text-ink">
                  {answerConfidence === null
                    ? "—"
                    : `${Math.round(answerConfidence * 100)}%`}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>rubric</dt>
                <dd className="font-mono text-ink">
                  {rubricAvg === null ? "—" : `${Math.round(rubricAvg * 100)}%`}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>readiness moved</dt>
                <dd className="font-mono text-ink">
                  {readinessMoved}/{result.skillImpact.length}
                </dd>
              </div>
            </dl>
          </details>
        </div>
      </header>
      <div className="flex items-center gap-1 border-b border-line px-2">
        {(
          [
            ["feedback", "Feedback"],
            ["rubric", "Rubric"],
            ["answer", "Your answer"],
            ["evidence", "Evidence"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-current={evalTab === key ? "page" : undefined}
            onClick={() => setEvalTab(key)}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-[13px] ${
              evalTab === key
                ? "border-blue font-semibold text-navy"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="space-y-3 p-3" aria-live="polite">
        {evalTab === "feedback" && (
          <div className="max-w-prose space-y-3">
            {result.voiceFeedback && <DeliveryHints feedback={result.voiceFeedback} />}
            <p className="rounded-[var(--radius-sm)] bg-page p-2.5 text-sm">
              <RichText text={result.evaluation.summary} />
            </p>
            {result.evaluation.weaknesses.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-accent">What was missing</h3>
                <ul className="mt-1 space-y-1 text-sm text-muted">
                  {result.evaluation.weaknesses.map((w, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Pill tone={severityTone(w.severity)}>{w.severity}</Pill>
                      <span>
                        <span className="font-medium text-ink">{skillLabel(w.skill)}</span> —{" "}
                        <RichText text={w.evidence} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.evaluation.strengths.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-green">What went well</h3>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
                  {result.evaluation.strengths.map((s, i) => (
                    <li key={i}>
                      <RichText text={s.evidence} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.evaluation.star && (
              <div data-testid="star-checklist">
                <h3 className="text-[13px] font-semibold text-navy">STAR checklist</h3>
                <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {(
                    [
                      ["Situation", result.evaluation.star.situation],
                      ["Task", result.evaluation.star.task],
                      ["Action", result.evaluation.star.action],
                      ["Result", result.evaluation.star.result],
                    ] as const
                  ).map(([name, ok]) => (
                    <li key={name} className="flex items-center gap-2">
                      <span className={ok ? "text-green" : "text-accent"} aria-hidden>
                        {ok ? "✓" : "✗"}
                      </span>
                      <span className={ok ? "text-muted" : "font-medium text-ink"}>{name}</span>
                    </li>
                  ))}
                </ul>
                {result.evaluation.star.notes && (
                  <p className="mt-1 text-xs text-muted">{result.evaluation.star.notes}</p>
                )}
              </div>
            )}
            {result.evaluation.betterApproach && (
              <div>
                <h3 className="text-[13px] font-semibold text-navy">Better reasoning approach</h3>
                <p className="mt-1 text-sm text-muted">
                  <RichText text={result.evaluation.betterApproach} />
                </p>
              </div>
            )}
            {result.pluginReviews && result.pluginReviews.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-navy">Plugin reviews</h3>
                <div className="mt-1 space-y-2">
                  {result.pluginReviews.map((r) => (
                    <div key={r.pluginId} className="rounded-[var(--radius-sm)] bg-page p-2.5">
                      <p className="text-xs font-medium text-muted">from plugin {r.pluginName}</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                        {r.observations.map((o, i) => (
                          <li key={i} className={o.tone === "amber" ? "text-[var(--color-accent)]" : o.tone === "red" ? "text-[var(--color-danger)]" : ""}>
                            {o.text}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {result.newActions.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-navy">Next steps</h3>
                <ul className="mt-1 space-y-1.5">
                  {result.newActions.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3">
                      <span className="text-[13px] text-muted">{a.action}</span>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busy}
                        onClick={() => practiceAction(a)}
                      >
                        Practice
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {evalTab === "rubric" && (
          <div>
            <h3 className="mb-1 text-[13px] font-semibold text-navy">Rubric</h3>
            <RubricBars rubric={result.evaluation.rubric} />
          </div>
        )}

        {evalTab === "answer" && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-navy">Your answer</h3>
            <p className="whitespace-pre-wrap text-sm">{answer || "—"}</p>
            {code.trim() && (
              <div>
                <p className="text-xs text-muted">{language}</p>
                <pre className="mt-1 overflow-auto rounded-[var(--radius-sm)] bg-page p-2.5 font-mono text-xs">
                  {code}
                </pre>
              </div>
            )}
          </div>
        )}

        {evalTab === "evidence" && (
          <div className="space-y-3">
            <div>
              <h3 className="mb-1 text-[13px] font-semibold text-navy">Readiness change</h3>
              <DeltaList
                items={result.skillImpact.map((s) => ({
                  key: s.skillId,
                  label: skillLabel(s.skillId),
                  before: s.before,
                  after: s.after,
                }))}
              />
            </div>
            {evalEvidence.length > 0 && (
              <div>
                <h3 className="mb-1 text-[13px] font-semibold text-navy">
                  Evidence recorded
                </h3>
                <EvidenceTimeline
                  items={evalEvidence}
                  showSkill
                  empty="No evidence recorded for this answer yet."
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const resultFooter = result && (
    <Panel bodyClassName="flex flex-wrap items-center gap-3">
      <StreamDraft stage={stage} draft={draft} />
      {result.newActions.length > 0 && (
        <span className="text-xs text-muted">
          {result.newActions.length}{" "}
          {result.newActions.length === 1 ? "action" : "actions"} added to your plan ·{" "}
          <Link to="/prepare" className="text-blue underline">
            View plan
          </Link>
        </span>
      )}
      <div className="ms-auto flex items-center gap-3">
        {result.nextAvailable === "question" ? (
          <Button size="small" onClick={next} disabled={busy}>Next Question</Button>
        ) : (
          <Button size="small" onClick={finish} disabled={busy}>Finish Interview</Button>
        )}
        {busy && stage && (
          <span role="status" aria-live="polite" className="text-[13px] text-muted">{stage}…</span>
        )}
      </div>
    </Panel>
  );

  const allAnsweredPanel = (
    <Panel>
      <p className="text-sm">All planned questions answered.</p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="small" onClick={finish} disabled={busy}>Finish Interview</Button>
        {busy && stage && (
          <span role="status" aria-live="polite" className="text-[13px] text-muted">{stage}…</span>
        )}
      </div>
      <StreamDraft stage={stage} draft={draft} />
    </Panel>
  );

  const inspector = hasInspector && detail && (
    <div className={`flex min-h-0 shrink-0 flex-col ${inspectorOpen ? "w-60" : "w-9"}`}>
      {inspectorOpen ? (
        <Panel
          className="h-full"
          bodyClassName="pt-1"
          actions={
            <Button size="small" variant="ghost" aria-label="Collapse inspector" onClick={() => setInspectorOpen(false)}>
              »
            </Button>
          }
        >
          <PluginModeSlot
            slot="interview.sidebar"
            modeId={detail.session.roundType}
            params={{
              modeId: detail.session.roundType,
              state: detail.session.modeState ?? {},
              focus:
                focusDimension ??
                (detail.session.modeState?.focusDimension as string | null) ??
                null,
            }}
          />
        </Panel>
      ) : (
        <Panel className="h-full" bodyClassName="flex justify-center">
          <Button
            size="small"
            variant="ghost"
            aria-label="Expand inspector"
            data-testid="inspector-toggle"
            onClick={() => setInspectorOpen(true)}
          >
            «
          </Button>
        </Panel>
      )}
    </div>
  );

  // The composer (current question + editor, or the post-answer controls) stays
  // pinned at the bottom; the transcript scrolls above it.
  const showTranscript = transcript.length > 0 || (result !== null && current !== null);
  const composerClass = answering
    ? showTranscript
      ? "mt-3 flex h-[55%] min-h-0 shrink-0 flex-col"
      : "mt-3 flex min-h-0 flex-1 flex-col"
    : "mt-3 flex shrink-0 flex-col";
  const currentAnswerText = fieldsMode
    ? answerFields.map((f) => `${f.label}: ${fieldValues[f.key] ?? "—"}`).join("\n")
    : answer;

  return (
    <Workspace
      scroll={false}
      toolbar={
        <ScreenToolbar
          title={
            <>
              {detail?.session.mode === "practice" ? "Practice" : modeLabel}
              {detail?.companyProfile && (
                <span className="text-sm font-normal text-muted">
                  {" "}· {detail.companyProfile.name} profile
                </span>
              )}
              <span className="text-sm font-normal text-muted">
                {loop && detail?.session.loopRound ? (
                  <> · Loop round {detail.session.loopRound} / {loop.rounds.length}</>
                ) : (
                  <> · Round {round} / {detail?.session.plannedQuestions}</>
                )}
              </span>
              {loop && (
                <Link
                  to={`/interview/loop/${loop.id}`}
                  className="text-sm font-normal text-blue underline"
                  data-testid="loop-link"
                >
                  {" "}view loop
                </Link>
              )}
            </>
          }
          actions={
            (!done && !discarded) || hasInspector ? (
              <div className="flex items-center gap-2">
                {!done && !discarded && (
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={finish}
                    disabled={busy}
                    data-testid="end-interview"
                  >
                    End interview
                  </Button>
                )}
                {hasInspector && (
                  <Button
                    size="small"
                    variant="ghost"
                    aria-label={inspectorOpen ? "Collapse inspector" : "Expand inspector"}
                    onClick={() => setInspectorOpen((v) => !v)}
                  >
                    {inspectorOpen ? "»" : "«"}
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
      }
    >
      <ErrorNote error={error} />
      <PluginSlot slot="interview.toolbar" params={{ sessionId: id }} />
      {usageStrip}

      {!done && !discarded && detail && (
        <div className="mt-3 flex min-h-0 flex-1 gap-3">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {showTranscript && (
              <div
                ref={transcriptRef}
                data-testid="transcript"
                className="min-h-0 flex-1 space-y-3 overflow-auto pe-1"
                aria-live="polite"
              >
                {transcript.map((turn) => (
                  <div key={turn.question.id} className="space-y-2">
                    <InterviewerQuestion text={turn.question.text} />
                    {turn.answer && (
                      <AnswerBubble text={turn.answer.text} code={turn.answer.code} />
                    )}
                    {turn.evaluation && <EvaluationSummary evaluation={turn.evaluation} />}
                    {turn.followUps.some((f) => f.answer) && (
                      <div className="space-y-2 border-s-2 border-divider ps-3">
                        {turn.followUps
                          .filter((f) => f.answer)
                          .map((f) => (
                            <div key={f.question.id} className="space-y-2">
                              <InterviewerQuestion text={f.question.text} />
                              {f.answer && (
                                <AnswerBubble text={f.answer.text} code={f.answer.code} />
                              )}
                              {f.evaluation && <EvaluationSummary evaluation={f.evaluation} />}
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
                {result && current && (
                  <div className="space-y-2" data-testid="current-turn">
                    <InterviewerQuestion text={current.text} />
                    <AnswerBubble text={currentAnswerText} code={code || null} />
                    {evaluationPanel}
                  </div>
                )}
              </div>
            )}
            <div className={composerClass}>
              {result ? resultFooter : current ? running : allAnsweredPanel}
            </div>
          </div>
          {!result && inspector}
        </div>
      )}

      {discarded && !debrief && (
        <Panel className="mt-3 shrink-0" title="Session discarded">
          <p className="text-sm text-muted">
            This session was discarded before it finished. Your answered questions still
            count toward readiness.
          </p>
        </Panel>
      )}

      {debrief && (
        <Panel className="mt-3 flex-1" title="Debrief" scroll>
          <p className="text-sm">{debrief.summary}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <h3 className="text-[13px] font-semibold text-green">Went well</h3>
              <ul className="mt-1 list-disc pl-5 text-[13px] text-muted">
                {debrief.wentWell.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="text-[13px] font-semibold text-accent">To improve</h3>
              <ul className="mt-1 list-disc pl-5 text-[13px] text-muted">
                {debrief.toImprove.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="text-[13px] font-semibold text-navy">Next actions</h3>
              <ul className="mt-1 list-disc pl-5 text-[13px] text-muted">
                {debrief.nextActions.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          </div>
          {loop &&
            (() => {
              const nextRound = loop.rounds.find(
                (r) => r.status === "in_progress" && r.sessionId !== id,
              );
              if (nextRound?.sessionId) {
                return (
                  <div className="mt-3">
                    <Link to={`/interview/${nextRound.sessionId}`}>
                      <Button size="small" data-testid="next-round">
                        Continue to round {loop.rounds.indexOf(nextRound) + 1}:{" "}
                        {nextRound.label || nextRound.mode}
                      </Button>
                    </Link>
                  </div>
                );
              }
              if (loop.status === "complete") {
                return (
                  <div className="mt-3">
                    <Link to={`/interview/loop/${loop.id}`} className="text-blue underline">
                      View the loop debrief →
                    </Link>
                  </div>
                );
              }
              return null;
            })()}
        </Panel>
      )}

      {done && detail && (
        /* D1: the debrief must stay mode-scoped, or another mode's panel (e.g.
           system-design inside a coding debrief) leaks in. */
        <div className="mt-3 shrink-0">
          <PluginModeSlot
            slot="interview.sidebar"
            modeId={detail.session.roundType}
            params={{
              sessionId: id,
              modeId: detail.session.roundType,
              state: detail.session.modeState ?? {},
            }}
          />
        </div>
      )}
    </Workspace>
  );
}
