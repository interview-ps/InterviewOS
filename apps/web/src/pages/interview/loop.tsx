import { Link, useParams } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { api, type InterviewLoop, type LoopRound } from "@/lib/api";
import {
  Button,
  DeltaList,
  ErrorNote,
  Panel,
  Pill,
  ScreenToolbar,
  Skeleton,
  Workspace,
  pct,
  signalTone,
  skillLabel,
  statusTone,
} from "@/components/ui";
import { useSetPageTitle } from "@/lib/page-title";

function SkillDeltas({ deltas }: { deltas: LoopRound["skillDeltas"] }) {
  if (!deltas?.length) return null;
  return (
    <DeltaList
      items={deltas.map((d) => ({
        key: d.skillId,
        label: d.label || skillLabel(d.skillId),
        before: d.before,
        after: d.after,
      }))}
    />
  );
}

export default function LoopPage() {
  const id = useParams().id ?? "";
  const [loop, setLoop] = useState<InterviewLoop | null>(null);

  // Descriptive breadcrumb name instead of the loop id (D2).
  useSetPageTitle("Interview loop");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.loop(id).then(setLoop).catch((e) => setError(e));
  }, [id]);
  useEffect(load, [load]);

  const abandon = async () => {
    setBusy(true);
    try {
      setLoop(await api.abandonLoop(id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorNote error={error} />;
  if (!loop) {
    return (
      <Workspace toolbar={<ScreenToolbar title="Interview loop" />} bodyClassName="space-y-3">
        <Skeleton className="h-48 w-full" />
      </Workspace>
    );
  }

  const signalFor = (i: number) => loop.debrief?.rounds[i] ?? null;
  const currentRound = loop.rounds[loop.currentRound - 1];

  return (
    <Workspace
      toolbar={
        <ScreenToolbar
          title={
            <>
              Interview loop{" "}
              <span className="text-sm font-normal text-muted">
                · round {Math.min(loop.currentRound, loop.rounds.length)} of {loop.rounds.length}
              </span>
            </>
          }
          actions={
            <>
              {loop.abandoned && <Pill tone="amber">abandoned</Pill>}
              <Pill tone={statusTone(loop.status)}>{loop.status}</Pill>
              {loop.status !== "complete" && (
                <Button variant="ghost" size="small" onClick={abandon} disabled={busy} data-testid="abandon-loop">
                  Abandon loop
                </Button>
              )}
            </>
          }
        />
      }
    >
      <ErrorNote error={error} />

      <div className="max-w-4xl space-y-3">
        <Panel title="Rounds">
          <ol className="space-y-1.5">
            {loop.rounds.map((r: LoopRound, i: number) => {
              const signal = signalFor(i);
              return (
                <li key={i} className="rounded-[var(--radius-sm)] border border-line p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-ink">
                        {i + 1}. {r.label || r.mode}
                      </span>
                      <Pill tone="muted">{r.mode.replace("_", " ")}</Pill>
                      <Pill tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Pill>
                      {signal && <Pill tone={signalTone(signal.signal)}>{signal.signal}</Pill>}
                    </div>
                    <div className="flex items-center gap-3 text-[13px]">
                      <span className="text-muted">
                        readiness {pct(r.readinessBefore?.overall)} → {pct(r.readinessAfter?.overall)}
                      </span>
                      {r.sessionId && (
                        <Link to={`/interview/${r.sessionId}`} className="text-blue underline">
                          Open session
                        </Link>
                      )}
                    </div>
                  </div>
                  {signal && signal.evidence.length > 0 && (
                    <ul className="mt-1.5 list-disc pl-5 text-xs text-muted">
                      {signal.evidence.map((e, j) => (
                        <li key={j}>{e}</li>
                      ))}
                    </ul>
                  )}
                  {r.handoff && (r.handoff.weakSkills.length > 0 || r.handoff.strongSkills.length > 0) && (
                    <div className="mt-1.5 rounded bg-page p-2 text-xs text-muted" data-testid={`handoff-${i}`}>
                      {loop.status === "complete" ? "Carried between rounds: " : "Carried forward: "}
                      {r.handoff.weakSkills.length > 0 && (
                        <span>
                          weak {r.handoff.weakSkills.map((w) => w.label || skillLabel(w.skillId)).join(", ")}{" "}
                          {loop.status === "complete"
                            ? "— later rounds probed related skills. "
                            : "→ next rounds will probe related skills. "}
                        </span>
                      )}
                      {r.handoff.strongSkills.length > 0 && (
                        <span>
                          strong {r.handoff.strongSkills.map((s) => s.label || skillLabel(s.skillId)).join(", ")}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </Panel>

        {loop.debrief && (
          <Panel title="Loop debrief" data-testid="loop-debrief">
            <p className="text-[13px]">{loop.debrief.summary}</p>
            <p className="mt-1.5 text-[13px] text-muted">
              Readiness change: {pct(loop.debrief.readinessChange.before)} →{" "}
              {pct(loop.debrief.readinessChange.after)}
            </p>
            {loop.rounds.some((r) => r.skillDeltas?.length > 0) && (
              <div className="mt-2 space-y-1.5" data-testid="debrief-deltas">
                <p className="text-[13px] font-medium text-ink">Readiness change after each round</p>
                {loop.rounds.map((r, i) =>
                  r.skillDeltas?.length > 0 ? (
                    <div key={i} className="text-xs text-muted">
                      <span className="font-medium text-ink">
                        {i + 1}. {r.label || r.mode.replace("_", " ")}:
                      </span>
                      <SkillDeltas deltas={r.skillDeltas} />
                    </div>
                  ) : null,
                )}
              </div>
            )}
            {loop.debrief.topActions.length > 0 && (
              <div className="mt-2">
                <p className="text-[13px] font-medium text-ink">Top actions</p>
                <ul className="mt-1 list-disc pl-5 text-[13px] text-muted">
                  {loop.debrief.topActions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        )}

        {loop.status === "in_progress" && currentRound?.sessionId && (
          <Panel title="Current round">
            <p className="text-[13px] text-muted">
              Round {loop.currentRound} of {loop.rounds.length}: {currentRound.label || currentRound.mode}
            </p>
            <div className="mt-2">
              <Link to={`/interview/${currentRound.sessionId}`}>
                <Button size="small">Continue</Button>
              </Link>
            </div>
          </Panel>
        )}
      </div>
    </Workspace>
  );
}
