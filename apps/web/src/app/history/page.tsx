"use client";

import { useEffect, useState } from "react";
import { api, type InterviewListItem, type SessionDetail } from "@/lib/api";
import { Card, CardTitle, ErrorNote, Pill, Spinner } from "@/components/ui";

export default function History() {
  const [sessions, setSessions] = useState<InterviewListItem[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.listInterviews().then(setSessions).catch((e) => setError(e));
  }, []);

  const toggle = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(id);
    setDetail(null);
    api.interview(id).then(setDetail).catch((e) => setError(e));
  };

  if (!sessions && !error) return <Spinner label="Loading history…" />;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-navy">History</h1>
      <ErrorNote error={error} />
      {sessions?.length === 0 && (
        <Card><p className="text-sm text-muted">No past interviews.</p></Card>
      )}
      {sessions?.map((s) => (
        <Card key={s.id}>
          <button onClick={() => toggle(s.id)} aria-expanded={expanded === s.id} className="w-full text-left">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{new Date(s.createdAt).toLocaleString()}</span>
              <Pill tone={s.status === "debrief" ? "green" : "muted"}>{s.status}</Pill>
              <span className="text-sm text-muted">{s.questions} questions</span>
              <span className="ml-auto text-muted" aria-hidden>{expanded === s.id ? "▾" : "▸"}</span>
            </div>
          </button>
          {expanded === s.id && (
            <div className="mt-3 space-y-3 border-t border-line pt-3">
              {!detail && <Spinner />}
              {detail?.questions.map((q) => {
                const ans = detail.answers.find((a) => a.questionId === q.id);
                const idx = detail.questions.indexOf(q);
                const ev = detail.evaluations[idx];
                return (
                  <div key={q.id} className="rounded-[0.6rem] bg-page p-3 text-sm">
                    <p className="font-medium">{q.text}</p>
                    {ans && <p className="mt-1 text-muted">“{ans.text}”</p>}
                    {ev && (
                      <p className="mt-1 text-xs text-muted">
                        {ev.summary} {ev.scores[0] ? `· score ${Math.round(ev.scores[0].score * 100)}%` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
              {detail?.debrief && (
                <div className="rounded-[0.6rem] bg-green-tint p-3 text-sm">
                  <p className="font-medium text-green">Debrief</p>
                  <p className="mt-1">{detail.debrief.summary}</p>
                </div>
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
