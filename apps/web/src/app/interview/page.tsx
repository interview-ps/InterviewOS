"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type InterviewListItem } from "@/lib/api";
import { Button, Card, CardTitle, ErrorNote, Pill, Spinner } from "@/components/ui";

export default function Interview() {
  const router = useRouter();
  const [sessions, setSessions] = useState<InterviewListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.listInterviews().then(setSessions).catch((e) => setError(e));
  }, []);

  const start = () => {
    setStarting(true);
    api
      .startInterview(4)
      .then((r) => r.session && router.push(`/interview/${r.session.id}`))
      .catch((e) => setError(e))
      .finally(() => setStarting(false));
  };

  const live = sessions?.filter((s) => s.status !== "debrief") ?? [];
  const past = sessions?.filter((s) => s.status === "debrief") ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-navy">Interview</h1>
        <Button onClick={start} disabled={starting}>{starting ? "Preparing…" : "Start Interview"}</Button>
      </div>
      <ErrorNote error={error} />
      {!sessions && !error && <Spinner label="Loading sessions…" />}

      {live.map((s) => (
        <Card key={s.id}>
          <CardTitle>Session in progress</CardTitle>
          <p className="text-sm text-muted">
            Started {new Date(s.createdAt).toLocaleString()} · round {s.currentRound}/{s.plannedQuestions} ·{" "}
            <Pill tone="blue">{s.status}</Pill>
          </p>
          <div className="mt-3"><Link href={`/interview/${s.id}`}><Button>Resume</Button></Link></div>
        </Card>
      ))}

      {past.length > 0 && (
        <Card>
          <CardTitle>Past interviews</CardTitle>
          <ul className="space-y-2 text-sm">
            {past.map((s) => (
              <li key={s.id} className="flex items-center justify-between">
                <Link href={`/interview/${s.id}`} className="text-blue underline">
                  {new Date(s.createdAt).toLocaleString()}
                </Link>
                <span className="text-muted">{s.questions} questions</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {sessions?.length === 0 && (
        <Card><p className="text-sm text-muted">No interviews yet. Start one to begin practicing.</p></Card>
      )}
    </div>
  );
}
