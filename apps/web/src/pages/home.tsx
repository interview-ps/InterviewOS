import { Link, useNavigate } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { api, type AppState, type InterviewListItem, type Metrics } from "@/lib/api";
import { Bar, Button, Card, CardTitle, EmptyState, ErrorNote, PageHeader, Pill, SkeletonCard, StatusPill, skillLabel } from "@/components/ui";

/** One metric in the Progress card; `title` carries the explanation. */
function Metric({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <div title={title} className="rounded-[0.5rem] border border-line p-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-navy">{value}</dd>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [state, setState] = useState<AppState | null>(null);
  const [sessions, setSessions] = useState<InterviewListItem[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    api.state().then(setState).catch((e) => setError(e));
    api.listInterviews().then(setSessions).catch(() => {});
    api.metrics().then(setMetrics).catch(() => {});
  }, []);
  useEffect(load, [load]);

  if (error && !state) return <ErrorNote error={error} />;
  if (!state) {
    return (
      <div className="space-y-5">
        <SkeletonCard lines={1} />
        <div className="grid gap-5 md:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (state.candidate.id === "none" || state.target.id === "none") {
    return (
      <Card className="mx-auto mt-16 max-w-xl">
        <EmptyState
          title="Welcome to Interview OS"
          description="Set a target role — a job description plus your resume — to build an evidence-backed readiness model and start preparing."
          action={<Link to="/target"><Button>Define Target Role</Button></Link>}
        />
      </Card>
    );
  }

  const target = state.target;
  const readiness = state.readiness;
  const openActions = [...state.preparation.nextActions].sort((a, b) => a.priority - b.priority);
  const nextAction = openActions[0];
  const topGaps = [...state.assessment.gaps]
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 3);
  const requirements = target.requirements
    .map((r) => ({ req: r, rd: readiness.dimensions[r.skillId] }))
    .filter((x) => x.rd)
    .slice(0, 8);
  const lastSession = sessions[0];

  const startPractice = () => {
    if (!nextAction) return;
    setStarting(true);
    api
      .startInterview({
        mode: "practice",
        focusSkillId: nextAction.skillId,
        actionId: nextAction.id,
      })
      .then((r) => navigate(`/interview/${r.session!.id}`))
      .catch((e) => setError(e))
      .finally(() => setStarting(false));
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <>
            {target.role} <span className="font-normal text-muted">— {target.company}</span>
          </>
        }
        subtitle="Evidence-backed readiness for your target role."
        actions={<Pill tone="blue">{target.level}</Pill>}
      />

      <Card>
        <CardTitle>Overall readiness</CardTitle>
        <div className="flex items-center gap-4">
          <div className="flex-1"><Bar value={readiness.overall} /></div>
          <span className="w-12 text-right text-lg font-semibold text-navy">
            {Math.round(readiness.overall * 100)}%
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">
          confidence {Math.round(readiness.overallConfidence * 100)}% · updated{" "}
          {new Date(readiness.lastUpdated).toLocaleString()}
        </p>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardTitle>Focus areas</CardTitle>
          {topGaps.length === 0 ? (
            <p className="text-sm text-muted">No gaps detected.</p>
          ) : (
            <ul className="space-y-2">
              {topGaps.map((g) => (
                <li key={g.skillId} className="flex items-center justify-between gap-2 text-sm">
                  <span>{g.label || skillLabel(g.skillId)}</span>
                  <Pill tone={g.severity === "high" ? "amber" : "muted"}>{g.severity}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle>Next action</CardTitle>
          {!nextAction ? (
            <p className="text-sm text-muted">All preparation actions complete.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">{nextAction.action}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
                {nextAction.successCriteria.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
              <Button onClick={startPractice} disabled={starting}>
                {starting ? "Starting…" : "Start Practice"}
              </Button>
            </div>
          )}
          {error ? <div className="mt-3"><ErrorNote error={error} /></div> : null}
        </Card>
      </div>

      <Card>
        <CardTitle>Skill readiness</CardTitle>
        {requirements.length === 0 ? (
          <p className="text-sm text-muted">No skills assessed yet.</p>
        ) : (
          <ul className="space-y-2">
            {requirements.map(({ req, rd }) => (
              <li key={req.skillId} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
                <span className="truncate text-sm">{rd!.label || skillLabel(req.skillId)}</span>
                <StatusPill status={rd!.status} />
                <div className="col-span-2"><Bar value={rd!.score ?? 0} /></div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {metrics && (
        <Card data-testid="progress-card">
          <CardTitle>Progress</CardTitle>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label="Loops completed" value={`${metrics.loopsCompleted}/${metrics.loopsStarted}`}
              title="Interview loops finished (abandoned loops don't count as completed)." />
            <Metric label="Modes used"
              value={Object.keys(metrics.sessionsPerMode).filter((m) => metrics.sessionsPerMode[m] > 0).length.toString()}
              title={`Sessions per mode: ${Object.entries(metrics.sessionsPerMode).map(([m, n]) => `${m} ×${n}`).join(", ") || "none"}`} />
            <Metric label="Weakness retest"
              value={metrics.weaknessRetestRate.rate === null ? "—" : `${Math.round(metrics.weaknessRetestRate.rate * 100)}%`}
              title={`Skills that scored weak in an interview and were asked again later (same or related skill): ${metrics.weaknessRetestRate.retested}/${metrics.weaknessRetestRate.weakSkills}.`} />
            <Metric label="Improvement after prep"
              value={metrics.improvementAfterPrep === null ? "—" : `${metrics.improvementAfterPrep >= 0 ? "+" : ""}${Math.round(metrics.improvementAfterPrep * 100)}%`}
              title="Mean change in evidence scores for a skill after finishing its prep action." />
            <Metric label="Prep completion"
              value={metrics.prepCompletionRate.rate === null ? "—" : `${Math.round(metrics.prepCompletionRate.rate * 100)}%`}
              title={`Prep actions marked done: ${metrics.prepCompletionRate.done}/${metrics.prepCompletionRate.total}.`} />
            <Metric label="Readiness coverage"
              value={metrics.readinessCoverage.rate === null ? "—" : `${Math.round(metrics.readinessCoverage.rate * 100)}%`}
              title={`Required skills with an evidence-backed readiness score (confidence ≥ 40%): ${metrics.readinessCoverage.covered}/${metrics.readinessCoverage.total}.`} />
          </dl>
        </Card>
      )}

      {lastSession && (
        <Card>
          <CardTitle>Latest interview</CardTitle>
          <p className="text-sm">
            {new Date(lastSession.createdAt).toLocaleString()} · status{" "}
            <Pill tone={lastSession.status === "debrief" ? "green" : "muted"}>{lastSession.status}</Pill>
          </p>
          <Link to={`/interview/${lastSession.id}`} className="mt-2 inline-block text-sm text-blue underline">
            View session
          </Link>
        </Card>
      )}
    </div>
  );
}
