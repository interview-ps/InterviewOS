"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Debrief,
  type SessionDetail,
  type SessionQuestion,
  type SubmitAnswerResult,
} from "@/lib/api";
import { Bar, Button, Card, CardTitle, ErrorNote, Pill, Spinner, skillLabel } from "@/components/ui";

export default function InterviewSession() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [current, setCurrent] = useState<SessionQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<SubmitAnswerResult | null>(null);
  const [debrief, setDebrief] = useState<Debrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const d = await api.interview(id);
    setDetail(d);
    if (d.debrief) setDebrief(d.debrief);
    const answered = new Set(d.answers.map((a) => a.questionId));
    const pending = d.questions.find((q) => !answered.has(q.id)) ?? null;
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

  const submit = () => {
    setBusy(true);
    setError(null);
    tick();
    api
      .submitAnswer(id, answer)
      .then((r) => setResult(r))
      .catch((e) => setError(e))
      .finally(() => { setBusy(false); untick(); });
  };

  const next = () => {
    setBusy(true);
    setError(null);
    api
      .nextQuestion(id)
      .then(async (r) => {
        setAnswer("");
        setResult(null);
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
    api
      .completeInterview(id)
      .then((r) => { setDebrief(r.debrief); return load(); })
      .catch(async () => {
        const d = await api.debrief(id).catch(() => null);
        if (d) setDebrief(d);
        await load().catch(() => {});
      })
      .finally(() => setBusy(false));
  };

  if (!detail && !error) return <Spinner label="Loading session…" />;

  const done = debrief !== null;
  const round = detail ? Math.min(detail.session.currentRound, detail.session.plannedQuestions) : 0;

  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="text-xl font-bold text-navy">
        Interview <span className="text-sm font-normal text-muted">round {round} / {detail?.session.plannedQuestions}</span>
      </h1>
      <ErrorNote error={error} />

      {!done && current && (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="blue">{current.topic}</Pill>
            <Pill tone="muted">difficulty {current.difficulty}</Pill>
          </div>
          {current.selectionReason && (
            <p className="mt-2 text-xs text-muted">Why this question: {current.selectionReason}</p>
          )}
          <p className="mt-3 text-base font-medium leading-relaxed">{current.text}</p>

          {!result ? (
            <div className="mt-4">
              <label className="block text-sm">
                <span className="sr-only">Your answer</span>
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={7}
                  placeholder="Type your answer…"
                  className="w-full rounded-[0.6rem] border border-line p-3"
                />
              </label>
              <div className="mt-3 flex items-center gap-3">
                <Button onClick={submit} disabled={busy || !answer.trim()}>
                  {busy ? "Evaluating…" : "Submit Answer"}
                </Button>
                {busy && (
                  <span role="status" aria-live="polite" className="text-sm text-muted">
                    Evaluating… {elapsed}s
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4" aria-live="polite">
              <p className="rounded-[0.6rem] bg-page p-3 text-sm">{result.evaluation.summary}</p>
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
                        <Pill tone={w.severity === "high" ? "red" : w.severity === "medium" ? "amber" : "muted"}>
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
              <div className="flex gap-2">
                {result.nextAvailable === "question" ? (
                  <Button onClick={next} disabled={busy}>Next Question</Button>
                ) : (
                  <Button onClick={finish} disabled={busy}>Finish Interview</Button>
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      {!done && !current && detail && (
        <Card>
          <p className="text-sm">All planned questions answered.</p>
          <div className="mt-3"><Button onClick={finish} disabled={busy}>Finish Interview</Button></div>
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
        </Card>
      )}
    </div>
  );
}
