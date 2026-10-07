import { Link, useNavigate } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { api, type AppState, type InterviewListItem, type Metrics } from "@/lib/api";
import {
  Button,
  DeltaList,
  ErrorNote,
  GapSeverityBars,
  Panel,
  Pill,
  ScreenToolbar,
  Skeleton,
  StatStrip,
  Workspace,
  displayLabel,
  gapReason,
  pct,
  readinessVerdict,
  trendOf,
} from "@/components/ui";
import { ExtensionSlot } from "@/components/plugin-ui";
import { SetupForm } from "@/components/setup-form";
import { useAppRefresh, useAppRefreshEffect } from "@/lib/app-refresh";

type SkillDelta = {
  skillId: string;
  label: string;
  before: number | null;
  after: number | null;
};

export default function Dashboard() {
  const navigate = useNavigate();
  const refresh = useAppRefresh();
  const [state, setState] = useState<AppState | null>(null);
  const [sessions, setSessions] = useState<InterviewListItem[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [deltas, setDeltas] = useState<SkillDelta[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    api.state().then(setState).catch((e) => setError(e));
    api.listInterviews().then(setSessions).catch(() => {});
    api.metrics().then(setMetrics).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useAppRefreshEffect(load);

  // Readiness change since the last finished interview — the "what changed" answer.
  useEffect(() => {
    const lastDone = sessions.find((s) => s.status !== "in_progress");
    if (!lastDone) {
      setDeltas([]);
      return;
    }
    let cancelled = false;
    api
      .sessionHistory(lastDone.id)
      .then((h) => {
        if (cancelled) return;
        const bySkill = new Map<string, { before: number | null; after: number | null }>();
        const rows = h.questions.flatMap((q) => [q, ...q.followUps]);
        for (const q of rows) {
          for (const d of q.readinessDelta) {
            const cur = bySkill.get(d.skillId);
            if (!cur) bySkill.set(d.skillId, { before: d.before, after: d.after });
            else cur.after = d.after;
          }
        }
        setDeltas(
          [...bySkill].map(([skillId, v]) => ({
            skillId,
            label: displayLabel(skillId),
            ...v,
          })),
        );
      })
      .catch(() => !cancelled && setDeltas([]));
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  if (error && !state) return <ErrorNote error={error} />;
  if (!state) {
    return (
      <Workspace toolbar={<ScreenToolbar title="Home" />} bodyClassName="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-48 w-full" />
      </Workspace>
    );
  }

  if (state.candidate.id === "none" || state.target.id === "none") {
    return (
      <Workspace
        toolbar={
          <ScreenToolbar
            title="Welcome to Interview OS"
            subtitle="Four quick steps and you'll have a personalized preparation plan."
          />
        }
      >
        <div className="max-w-4xl">
          <Panel>
            <SetupForm
              mode="workspace"
              showSteps
              onDone={(r) => {
                if (r) navigate("/prepare");
                else refresh();
              }}
            />
          </Panel>
        </div>
      </Workspace>
    );
  }

  const target = state.target;
  const readiness = state.readiness;
  const openActions = state.preparation.nextActions
    .filter((a) => a.status === "open" || a.status === "in_progress")
    .sort((a, b) => a.priority - b.priority);
  const nextAction = openActions[0];

  const ranked = target.requirements
    .map((r) => ({ req: r, rd: readiness.dimensions[r.skillId] }))
    .filter((x) => x.rd);

  const gaps = [...state.assessment.gaps].sort((a, b) => b.gap - a.gap);
  const topGaps = gaps.slice(0, 5);
  const resolvedTop = topGaps.filter(
    (g) => (readiness.dimensions[g.skillId]?.score ?? 0) >= 0.6,
  ).length;

  const net = deltas.reduce((acc, d) => acc + ((d.after ?? 0) - (d.before ?? 0)), 0);
  const overallTrend =
    deltas.length > 0
      ? net > 0.005
        ? "up"
        : net < -0.005
          ? "down"
          : "flat"
      : trendOf(ranked.map((x) => x.rd!.score));

  const nextGap = nextAction
    ? state.assessment.gaps.find((g) => g.skillId === nextAction.skillId)
    : undefined;
  const nextReadiness = nextAction
    ? (readiness.dimensions[nextAction.skillId]?.score ?? null)
    : null;
  const nextDelta = nextAction ? deltas.find((d) => d.skillId === nextAction.skillId) : undefined;
  const impact = nextGap
    ? nextGap.severity === "high"
      ? "High impact"
      : nextGap.severity === "medium"
        ? "Medium impact"
        : "Lower impact"
    : "Prioritised";

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

  const lastSession = sessions[0];
  const improvedCount = deltas.filter(
    (d) => d.before !== null && d.after !== null && d.after > d.before,
  ).length;
  const coverage = metrics?.readinessCoverage ?? null;

  const why = !nextAction
    ? "No open preparation actions — run a mock interview to add fresh evidence."
    : nextDelta && nextDelta.before !== null && nextDelta.after !== null
      ? `Your last interview moved this from ${pct(nextDelta.before)} to ${pct(nextDelta.after)}.`
      : nextGap
        ? gapReason(nextGap)
        : "This is a priority for your target role.";

  return (
    <Workspace
      scroll={true}
      toolbar={
        <ScreenToolbar
          title={
            <>
              {target.role}{" "}
              <span className="text-sm font-normal text-muted">· {target.company}</span>
            </>
          }
          actions={
            <>
              <Pill tone="blue">{target.level}</Pill>
              <Link to="/target">
                <Button variant="secondary" size="small">
                  Change target
                </Button>
              </Link>
            </>
          }
        />
      }
    >
      <ErrorNote error={error} />

      <div className="space-y-3">
        <section>
          <h2 className="mb-1 text-sm font-semibold text-navy">Overall readiness</h2>
          <StatStrip
            items={[
              {
                label: "Estimated readiness",
                value: pct(readiness.overall),
                suffix:
                  overallTrend === "up"
                    ? "↑"
                    : overallTrend === "down"
                      ? "↓"
                      : overallTrend === "flat"
                        ? "→"
                        : undefined,
              },
              { label: "Confidence", value: pct(readiness.overallConfidence) },
              {
                label: "Coverage",
                value: coverage ? `${coverage.covered}/${coverage.total}` : "Not assessed",
                suffix: "required skills",
              },
              {
                label: "Verdict",
                value: (
                  <span className="text-[15px] font-semibold leading-snug">
                    {readinessVerdict(readiness.overall, coverage?.rate ?? null)}
                  </span>
                ),
                action: (
                  <Link to="/readiness" className="text-blue underline">
                    See the evidence
                  </Link>
                ),
              },
            ]}
          />
        </section>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            <Panel
              title="Next best action"
              className="border-s-[3px] border-s-[var(--color-blue)]"
              footer={
                nextAction ? (
                  <Button size="small" onClick={startPractice} disabled={starting}>
                    {starting ? "Starting…" : "Start practice"}
                  </Button>
                ) : (
                  <Link to="/interview">
                    <Button size="small">Start mock interview</Button>
                  </Link>
                )
              }
            >
              <p className="text-sm font-semibold text-navy">
                {nextAction ? `Practice ${displayLabel(nextAction.skillId)}` : "You're caught up"}
              </p>
              <p className="mt-1 text-[13px] text-muted">{why}</p>
              {nextAction && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
                  <span>
                    Current readiness:{" "}
                    <strong>{nextReadiness === null ? "Not assessed" : pct(nextReadiness)}</strong>
                  </span>
                  <span>
                    Impact: <strong>{impact}</strong>
                  </span>
                </p>
              )}
              {nextAction && nextAction.successCriteria.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[13px] text-muted">
                  {nextAction.successCriteria.slice(0, 4).map((c, i) => (
                    <li key={i}>· {c}</li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Recent progress"
              actions={
                lastSession ? (
                  <Link to={`/interview/${lastSession.id}`} className="text-xs text-blue underline">
                    View session
                  </Link>
                ) : undefined
              }
            >
              {topGaps.length > 0 && (
                <p className="mb-2 text-[13px]">
                  You've resolved <strong>{resolvedTop}</strong> of your top {topGaps.length} gaps.
                </p>
              )}
              <DeltaList
                empty="No interview evidence yet — run one to start tracking change."
                items={deltas.map((d) => ({
                  key: d.skillId,
                  label: d.label,
                  before: d.before,
                  after: d.after,
                }))}
              />
            </Panel>

            <ExtensionSlot slot="dashboard.cards" />
          </div>

          <div className="space-y-3">
            <Panel
              title="Preparation priorities"
              padded={false}
              actions={
                <Link to="/prepare" className="text-xs text-blue underline">
                  Open plan
                </Link>
              }
            >
              <GapSeverityBars
                gaps={gaps.slice(0, 6).map((g) => ({
                  skillId: g.skillId,
                  label: displayLabel(g.skillId, g.label),
                  severity: g.severity,
                  importance: g.importance,
                  gap: g.gap,
                  currentScore: g.currentScore,
                  targetScore: g.targetScore,
                }))}
                meta={(g) =>
                  g.currentScore === null
                    ? "No evidence yet — your target expects this skill."
                    : gapReason(g)
                }
              />
            </Panel>

            <Panel title="Interview readiness">
              <div className="space-y-2 text-[13px]">
                {openActions.length > 0 ? (
                  <>
                    <p>
                      <strong>{openActions.length}</strong> open preparation{" "}
                      {openActions.length === 1 ? "action" : "actions"} — start with the highest
                      priority.
                    </p>
                    <Link to="/prepare">
                      <Button variant="secondary" size="small">
                        Open preparation plan
                      </Button>
                    </Link>
                  </>
                ) : improvedCount > 0 ? (
                  <>
                    <p>
                      You improved <strong>{improvedCount}</strong>{" "}
                      {improvedCount === 1 ? "skill" : "skills"} in your last interview.
                    </p>
                    <Link to="/interview">
                      <Button variant="secondary" size="small">Start mock interview</Button>
                    </Link>
                  </>
                ) : (
                  <>
                    <p className="text-muted">Run a mock interview to find out where you stand.</p>
                    <Link to="/interview">
                      <Button variant="secondary" size="small">Start mock interview</Button>
                    </Link>
                  </>
                )}
              </div>
            </Panel>
          </div>
        </div>

        {metrics && (
          <Panel title="Progress" data-testid="progress-card">
            <StatStrip
              items={[
                {
                  label: "Loops completed",
                  value: `${metrics.loopsCompleted}/${metrics.loopsStarted}`,
                },
                {
                  label: "Modes used",
                  value: Object.keys(metrics.sessionsPerMode)
                    .filter((m) => metrics.sessionsPerMode[m] > 0)
                    .length.toString(),
                },
                {
                  label: "Weakness retest",
                  value:
                    metrics.weaknessRetestRate.rate === null
                      ? "No data"
                      : `${Math.round(metrics.weaknessRetestRate.rate * 100)}%`,
                },
                {
                  label: "Improvement after prep",
                  value:
                    metrics.improvementAfterPrep === null
                      ? "No data"
                      : `${metrics.improvementAfterPrep >= 0 ? "+" : ""}${Math.round(
                          metrics.improvementAfterPrep * 100,
                        )}%`,
                },
                {
                  label: "Prep completion",
                  value:
                    metrics.prepCompletionRate.rate === null
                      ? "No data"
                      : `${Math.round(metrics.prepCompletionRate.rate * 100)}%`,
                },
                {
                  label: "Readiness coverage",
                  value:
                    metrics.readinessCoverage.rate === null
                      ? "No data"
                      : `${Math.round(metrics.readinessCoverage.rate * 100)}%`,
                },
              ]}
            />
          </Panel>
        )}

        <ExtensionSlot slot="dashboard.sidebar" />
      </div>
    </Workspace>
  );
}
