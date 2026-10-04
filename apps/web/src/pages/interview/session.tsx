import { Link, useParams } from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMode } from "@interview-os/core";
import {
  api,
  streamPost,
  type CodingProblem,
  type Debrief,
  type DesignDimensionStatus,
  type InterviewLoop,
  type SessionDetail,
  type SessionQuestion,
  type StartInterviewResult,
  type SubmitAnswerResult,
} from "@/lib/api";
import { Bar, Button, Card, CardTitle, ErrorNote, Pill, SkeletonCard, severityTone, skillLabel } from "@/components/ui";

const CODE_LANGUAGES = [
  "python", "javascript", "typescript", "java", "go", "cpp", "csharp",
  "ruby", "rust", "kotlin", "swift", "sql", "other",
];

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
    <p className="mt-3 rounded-[0.6rem] bg-page p-3 text-sm text-muted" aria-live="polite">
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

/** §9.2: expandable factor breakdown behind "Why this question". */
function WhyThisQuestion({ q }: { q: SessionQuestion }) {
  if (!q.selectionReason && !q.selectionFactors) return null;
  const f = q.selectionFactors;
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer">Why this question</summary>
      {q.selectionReason && <p className="mt-1">{q.selectionReason}</p>}
      {f && (
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
      )}
    </details>
  );
}

function CodingProblemPanel({ problem }: { problem: CodingProblem }) {
  return (
    <div className="mt-3 rounded-[0.6rem] border border-line bg-page p-3 text-sm" data-testid="coding-problem">
      <p className="font-semibold text-navy">{problem.title}</p>
      <p className="mt-1 whitespace-pre-wrap text-muted">{problem.statement}</p>
      {problem.constraints.length > 0 && (
        <>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted">Constraints</p>
          <ul className="mt-0.5 list-disc pl-5 text-xs text-muted">
            {problem.constraints.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </>
      )}
      {problem.examples.length > 0 && (
        <>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted">Examples</p>
          <ul className="mt-0.5 space-y-0.5 font-mono text-xs text-muted">
            {problem.examples.map((e, i) => (
              <li key={i}>
                {e.input} → {e.output}
                {e.explanation ? ` — ${e.explanation}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<DesignDimensionStatus, string> = {
  not_covered: "not covered",
  partial: "partial",
  covered: "covered",
};
const STATUS_TONE: Record<DesignDimensionStatus, "muted" | "amber" | "green"> = {
  not_covered: "muted",
  partial: "amber",
  covered: "green",
};

function DesignPanel({
  state,
  focus,
}: {
  state: Record<string, unknown>;
  focus: string | null;
}) {
  const dims = (state.dimensions ?? {}) as Record<
    string,
    { status: DesignDimensionStatus; notes: string }
  >;
  const rubric = getMode("system_design").rubric;
  const label = (id: string) => rubric.find((r) => r.id === id)?.label ?? id;
  return (
    <Card>
      <CardTitle>Design dimensions</CardTitle>
      {typeof state.problem === "string" && state.problem && (
        <p className="mb-2 text-xs text-muted">{state.problem}</p>
      )}
      <ul className="space-y-1 text-xs" data-testid="design-dimensions">
        {Object.entries(dims).map(([id, d]) => (
          <li
            key={id}
            className={`flex items-center justify-between gap-2 rounded px-1.5 py-1 ${
              focus === id ? "bg-tint ring-1 ring-blue" : ""
            }`}
          >
            <span className={focus === id ? "font-medium text-navy" : "text-ink"}>
              {label(id)}
            </span>
            <Pill tone={STATUS_TONE[d.status] ?? "muted"}>
              {STATUS_LABEL[d.status] ?? d.status}
            </Pill>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Mode rubric as compact dimension bars; weakest three show their rationale. */
function RubricBars({ rubric }: { rubric: { id: string; label: string; score: number; rationale: string }[] }) {
  if (rubric.length === 0) return null;
  const sorted = [...rubric].sort((a, b) => a.score - b.score);
  const weakest = new Set(sorted.slice(0, 3).map((r) => r.id));
  return (
    <div data-testid="rubric">
      <h3 className="text-sm font-semibold text-navy">Rubric</h3>
      <ul className="mt-1 space-y-1.5">
        {sorted.map((r) => (
          <li key={r.id}>
            <div className="flex items-center gap-3 text-sm">
              <span className="w-48 truncate text-muted" title={r.id}>{r.label}</span>
              <div className="w-40"><Bar value={r.score} /></div>
              <span className="text-xs text-muted">{Math.round(r.score * 100)}%</span>
            </div>
            {weakest.has(r.id) && r.rationale && (
              <p className="ml-1 mt-0.5 text-xs text-muted">{r.rationale}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function InterviewSession() {
  const id = useParams().id ?? "";
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [current, setCurrent] = useState<SessionQuestion | null>(null);
  const [answer, setAnswer] = useState("");
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
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    load().catch((e) => setError(e));
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  const tick = () => {
    setElapsed(0);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  };
  const untick = () => { if (timer.current) clearInterval(timer.current); };

  const progress = {
    onStage: (name: string) => setStage(name),
    onDelta: (field: string, text: string) => setDraft({ field, text }),
  };

  const isCoding = detail?.session.roundType === "coding";
  const isDesign = detail?.session.roundType === "system_design";

  const submit = () => {
    setBusy(true);
    setError(null);
    setStage(null);
    setDraft(null);
    tick();
    const body = isCoding
      ? { answer, ...(code.trim() ? { code, language } : {}) }
      : { answer };
    streamPost<SubmitAnswerResult>(`/api/interviews/${id}/answer`, body, progress)
      .then((r) => { setResult(r); setDraft(null); })
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
        setCode("");
        setResult(null);
        setDraft(null);
        if (r.question) setCurrent(r.question);
        else await load();
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

  if (!detail && !error) {
    return (
      <div className="max-w-3xl space-y-5">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  const done = debrief !== null;
  const round = detail ? Math.min(detail.session.currentRound, detail.session.plannedQuestions) : 0;
  const modeLabel = detail?.session.modeLabel ?? detail?.session.roundType.replace("_", " ");
  const codingProblem =
    isCoding && current?.extra?.problem && typeof current.extra.problem === "object"
      ? (current.extra.problem as CodingProblem)
      : null;
  const designFocus =
    typeof current?.extra?.focusDimension === "string" ? current.extra.focusDimension : null;

  const questionCard = !done && current && (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="blue">{current.topic}</Pill>
        <Pill tone="muted">difficulty {current.difficulty}</Pill>
        {current.followUpOf && (
          <Pill tone="amber">
            Follow-up{current.followUpFocus ? `: ${current.followUpFocus}` : ""}
          </Pill>
        )}
        {designFocus && <Pill tone="blue">focus: {designFocus}</Pill>}
      </div>
      <WhyThisQuestion q={current} />
      <p className="mt-3 text-base font-medium leading-relaxed">{current.text}</p>
      {codingProblem && <CodingProblemPanel problem={codingProblem} />}

      {!result ? (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="sr-only">Your answer</span>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={isCoding ? 4 : 7}
              placeholder={
                isCoding ? "Explain your approach…" : "Type your answer…"
              }
              className="w-full rounded-[0.6rem] border border-line p-3"
            />
          </label>
          {isCoding && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium">Code</span>
                <label className="flex items-center gap-2 text-xs text-muted">
                  Language
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    aria-label="Code language"
                    className="rounded-[0.4rem] border border-line bg-surface px-2 py-1 text-xs"
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
                rows={9}
                spellCheck={false}
                placeholder="Paste or write your solution — reviewed, not executed."
                aria-label="Code answer"
                className="w-full rounded-[0.6rem] border border-line bg-surface p-3 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted">Code is reviewed, not executed.</p>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={submit} disabled={busy || !answer.trim()}>
              {busy ? "Evaluating…" : "Submit Answer"}
            </Button>
            {busy && (
              <span role="status" aria-live="polite" className="text-sm text-muted">
                {stage ? `${stage}…` : "Evaluating…"} {elapsed}s
              </span>
            )}
          </div>
          {busy && <StreamDraft stage={stage} draft={draft} />}
        </div>
      ) : (
        <div className="mt-4 space-y-4" aria-live="polite">
          <p className="rounded-[0.6rem] bg-page p-3 text-sm">{result.evaluation.summary}</p>
          <RubricBars rubric={result.evaluation.rubric} />
          {result.evaluation.star && (
            <div data-testid="star-checklist">
              <h3 className="text-sm font-semibold text-navy">STAR checklist</h3>
              <ul className="mt-1 space-y-1 text-sm">
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-green">What went well</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
                {result.evaluation.strengths.length === 0 && <li>Nothing notable this time.</li>}
                {result.evaluation.strengths.map((s, i) => <li key={i}>{s.evidence}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-accent">What was missing</h3>
              <ul className="mt-1 space-y-1 text-sm text-muted">
                {result.evaluation.weaknesses.length === 0 && result.evaluation.missingConcepts.length === 0 && (
                  <li>Nothing significant missing.</li>
                )}
                {result.evaluation.weaknesses.map((w, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Pill tone={severityTone(w.severity)}>
                      {w.severity}
                    </Pill>
                    <span>
                      <span className="font-medium text-ink">{skillLabel(w.skill)}</span> — {w.evidence}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {result.evaluation.betterApproach && (
            <div>
              <h3 className="text-sm font-semibold text-navy">Better reasoning approach</h3>
              <p className="mt-1 text-sm text-muted">{result.evaluation.betterApproach}</p>
            </div>
          )}
          <div>
            <h3 className="text-sm font-semibold text-navy">Skill impact</h3>
            <ul className="mt-1 space-y-1.5">
              {result.skillImpact.map((s) => (
                <li key={s.skillId} className="flex items-center gap-3 text-sm">
                  <span className="w-48 truncate text-muted" title={s.skillId}>
                    {skillLabel(s.skillId)}
                  </span>
                  <div className="w-40"><Bar value={s.after ?? 0} /></div>
                  <span className="text-xs text-muted">
                    {s.before === null ? "new" : Math.round(s.before * 100) + "%"} →{" "}
                    {s.after === null ? "—" : Math.round(s.after * 100) + "%"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {result.newActions.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-navy">New prep actions</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
                {result.newActions.map((a) => <li key={a.id}>{a.action}</li>)}
              </ul>
            </div>
          )}
          <div className="flex items-center gap-3">
            {result.nextAvailable === "question" ? (
              <Button onClick={next} disabled={busy}>Next Question</Button>
            ) : (
              <Button onClick={finish} disabled={busy}>Finish Interview</Button>
            )}
            {busy && stage && (
              <span role="status" aria-live="polite" className="text-sm text-muted">
                {stage}…
              </span>
            )}
          </div>
          {busy && <StreamDraft stage={stage} draft={draft} />}
        </div>
      )}
    </Card>
  );

  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="flex items-center gap-2 text-xl font-bold text-navy">
        {detail?.session.mode === "practice" ? "Practice" : modeLabel}
        {detail?.session.mode === "practice" && <Pill tone="amber">Practice</Pill>}
        {detail?.companyProfile && (
          <span className="text-sm font-normal text-muted">
            · {detail.companyProfile.name} profile
          </span>
        )}
        <span className="text-sm font-normal text-muted">
          {loop && detail?.session.loopRound ? (
            <>· Loop round {detail.session.loopRound} / {loop.rounds.length}</>
          ) : (
            <>· Round {round} / {detail?.session.plannedQuestions}</>
          )}
        </span>
        {loop && (
          <Link
            to={`/interview/loop/${loop.id}`}
            className="text-sm font-normal text-blue underline"
            data-testid="loop-link"
          >
            view loop
          </Link>
        )}
      </h1>
      <ErrorNote error={error} />

      {isDesign && !done ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_15rem]">
          <div>{questionCard}</div>
          <DesignPanel
            state={detail?.session.modeState ?? {}}
            focus={designFocus ?? (detail?.session.modeState?.focusDimension as string | null) ?? null}
          />
        </div>
      ) : (
        questionCard
      )}

      {!done && !current && detail && (
        <Card>
          <p className="text-sm">All planned questions answered.</p>
          <div className="mt-3 flex items-center gap-3">
            <Button onClick={finish} disabled={busy}>Finish Interview</Button>
            {busy && stage && (
              <span role="status" aria-live="polite" className="text-sm text-muted">
                {stage}…
              </span>
            )}
          </div>
          {busy && <StreamDraft stage={stage} draft={draft} />}
        </Card>
      )}

      {debrief && (
        <Card>
          <CardTitle>Debrief</CardTitle>
          <p className="text-sm">{debrief.summary}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <div>
              <h3 className="text-sm font-semibold text-green">Went well</h3>
              <ul className="mt-1 list-disc pl-5 text-sm text-muted">
                {debrief.wentWell.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-accent">To improve</h3>
              <ul className="mt-1 list-disc pl-5 text-sm text-muted">
                {debrief.toImprove.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-navy">Next actions</h3>
              <ul className="mt-1 list-disc pl-5 text-sm text-muted">
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
                  <div className="mt-4 flex items-center gap-3">
                    <Link to={`/interview/${nextRound.sessionId}`}>
                      <Button data-testid="next-round">
                        Continue to round {loop.rounds.indexOf(nextRound) + 1}:{" "}
                        {nextRound.label || nextRound.mode}
                      </Button>
                    </Link>
                  </div>
                );
              }
              if (loop.status === "complete") {
                return (
                  <div className="mt-4">
                    <Link to={`/interview/loop/${loop.id}`} className="text-blue underline">
                      View the loop debrief →
                    </Link>
                  </div>
                );
              }
              return null;
            })()}
        </Card>
      )}
    </div>
  );
}
