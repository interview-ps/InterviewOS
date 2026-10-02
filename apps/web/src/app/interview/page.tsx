"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, streamPost, type InterviewListItem, type RoundType, type StartInterviewResult } from "@/lib/api";
import { Button, Card, CardTitle, ErrorNote, Pill, Spinner } from "@/components/ui";

const ROUND_OPTIONS: { value: RoundType; label: string; hint: string }[] = [
  { value: "mixed", label: "Mixed", hint: "Weakness-driven mix of all areas" },
  { value: "technical", label: "Technical", hint: "Depth on tools and implementation" },
  { value: "system_design", label: "System design", hint: "Open-ended design with scale" },
  { value: "behavioral", label: "Behavioral", hint: "STAR stories from your experience" },
  { value: "hr", label: "HR", hint: "Motivation, goals and culture fit" },
];

export default function Interview() {
  const router = useRouter();
  const [sessions, setSessions] = useState<InterviewListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [roundType, setRoundType] = useState<RoundType>("mixed");

  useEffect(() => {
    api.listInterviews().then(setSessions).catch((e) => setError(e));
  }, []);

  const start = () => {
    setStarting(true);
    setStage(null);
    streamPost<StartInterviewResult>("/api/interviews", { plannedQuestions: 4, roundType }, {
      onStage: setStage,
    })
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
      <Card>
        <CardTitle>Round type</CardTitle>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {ROUND_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`cursor-pointer rounded-[0.6rem] border p-3 text-sm ${
                roundType === o.value ? "border-blue bg-page" : "border-line"
              }`}
            >
              <input
                type="radio"
                name="roundType"
                value={o.value}
                checked={roundType === o.value}
                onChange={() => setRoundType(o.value)}
                className="sr-only"
              />
              <span className="block font-medium text-ink">{o.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>
            </label>
          ))}
        </div>
      </Card>
      {starting && (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-blue align-middle" aria-hidden />
          {stage ? `${stage}…` : "Preparing…"}
        </p>
      )}
      <ErrorNote error={error} />
      {!sessions && !error && <Spinner label="Loading sessions…" />}

      {live.map((s) => (
        <Card key={s.id}>
          <CardTitle>{s.mode === "practice" ? "Practice session in progress" : "Session in progress"}</CardTitle>
          <p className="text-sm text-muted">
            Started {new Date(s.createdAt).toLocaleString()} · round {s.currentRound}/{s.plannedQuestions} ·{" "}
            {s.mode === "practice" && <Pill tone="amber">Practice</Pill>}{" "}
            {s.mode !== "practice" && s.roundType !== "mixed" && (
              <Pill tone="blue">{s.roundType.replace("_", " ")}</Pill>
            )}{" "}
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
              <li key={s.id} className="flex items-center justify-between gap-2">
                <Link href={`/interview/${s.id}`} className="text-blue underline">
                  {new Date(s.createdAt).toLocaleString()}
                </Link>
                <span className="flex items-center gap-2 text-muted">
                  {s.mode === "practice" && <Pill tone="amber">Practice</Pill>}
                  {s.questions} questions
                </span>
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
