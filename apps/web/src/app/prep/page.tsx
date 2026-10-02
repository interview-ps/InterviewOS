"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type PrepAction } from "@/lib/api";
import { Button, Card, CardTitle, ErrorNote, Pill, Spinner, skillLabel } from "@/components/ui";

const ACTION_STATUS: Record<string, string> = {
  open: "open",
  in_progress: "in progress",
  done: "done",
  superseded: "superseded",
};

export default function PrepPlan() {
  const [actions, setActions] = useState<PrepAction[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => {
    api.preparation().then((p) => setActions(p.actions)).catch((e) => setError(e));
  }, []);
  useEffect(load, [load]);

  const act = (id: string, status: "open" | "in_progress" | "done") => {
    setBusy(id);
    api.updateAction(id, status).then(load).catch((e) => setError(e)).finally(() => setBusy(null));
  };

  const recalc = () => {
    setBusy("recalc");
    api.recalculatePlan().then(load).catch((e) => setError(e)).finally(() => setBusy(null));
  };

  if (!actions && !error) return <Spinner label="Loading prep plan…" />;

  const open = (actions ?? [])
    .filter((a) => a.status === "open" || a.status === "in_progress")
    .sort((a, b) => a.priority - b.priority);
  const history = (actions ?? [])
    .filter((a) => a.status === "done" || a.status === "superseded")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-navy">Prep Plan</h1>
        <Button variant="secondary" onClick={recalc} disabled={busy === "recalc"}>
          {busy === "recalc" ? "Recalculating…" : "Recalculate"}
        </Button>
      </div>
      <ErrorNote error={error} />

      {open.length === 0 && !error && (
        <Card><p className="text-sm text-muted">No open actions. Set a target role or recalculate the plan.</p></Card>
      )}

      {open.map((a) => (
        <Card key={a.id} className={a.priority === 1 ? "border-accent" : ""}>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={a.priority === 1 ? "amber" : "muted"}>#{a.priority}</Pill>
            <span className="font-medium">{skillLabel(a.skillId)}</span>
            <Pill tone={a.status === "in_progress" ? "blue" : "muted"}>{ACTION_STATUS[a.status]}</Pill>
          </div>
          <p className="mt-2 text-sm">{a.action}</p>
          {a.reason && <p className="mt-1 text-xs text-muted">Why: {a.reason}</p>}
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted">
            {a.successCriteria.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
          <div className="mt-3 flex gap-2">
            {a.status === "open" && (
              <Button variant="secondary" disabled={busy === a.id} onClick={() => act(a.id, "in_progress")}>
                Start
              </Button>
            )}
            <Button disabled={busy === a.id} onClick={() => act(a.id, "done")}>Mark done</Button>
          </div>
        </Card>
      ))}

      {history.length > 0 && (
        <Card>
          <button
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            className="flex w-full items-center justify-between text-left"
          >
            <CardTitle>History ({history.length})</CardTitle>
            <span aria-hidden className="text-muted">{showHistory ? "▾" : "▸"}</span>
          </button>
          {showHistory && (
            <ul className="space-y-2 text-sm">
              {history.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 border-t border-line pt-2">
                  <span className="text-muted line-through">{a.action}</span>
                  <Pill tone={a.status === "done" ? "green" : "muted"}>{ACTION_STATUS[a.status]}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
