import { Link, useNavigate } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { api, type AppState, type InterviewListItem, type Metrics } from "@/lib/api";
import {
  Button,
  Card,
  DeltaList,
  ErrorNote,
  NextActionCard,
  PageHeader,
  Pill,
  PriorityList,
  ReadinessHero,
  SectionHeading,
  SkeletonCard,
  pct,
  severityTone,
  skillLabel,
  trendOf,
} from "@/components/ui";
import { PluginSlot } from "@/components/plugin-ui";

type SkillDelta = {
  skillId: string;
  label: string;
  before: number | null;
  after: number | null;
};

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
  const [deltas, setDeltas] = useState<SkillDelta[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    api.state().then(setState).catch((e) => setError(e));
    api.listInterviews().then(setSessions).catch(() => {});
    api.metrics().then(setMetrics).catch(() => {});
  }, []);
  useEffect(load, [load]);

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
            label: skillLabel(skillId),
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
      <div className="space-y-5">
        <SkeletonCard lines={2} />
        <SkeletonCard />
      </div>
    );
  }

  if (state.candidate.id === "none" || state.target.id === "none") {
    return (
      <Card className="mx-auto mt-16 max-w-xl">
        <div className="text-center">
          <h2 className="text-lg font-semibold">Set up your interview preparation</h2>
          <p className="mt-2 text-sm text-muted">
            Add a job description and your resume to build an evidence-backed readiness
            model and get a preparation plan.
          </p>
          <div className="mt-4">
            <Link to="/target">
              <Button>Set up target role</Button>
            </Link>
          </div>
        </div>
      </Card>
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

  const strongest = [...ranked]
    .filter((x) => x.rd!.score !== null)
    .sort((a, b) => (b.rd!.score ?? 0) - (a.rd!.score ?? 0))
    .slice(0, 3)
    .map((x) => ({ label: x.rd!.label || skillLabel(x.req.skillId), value: x.rd!.score }));

  const gaps = [...state.assessment.gaps].sort((a, b) => b.gap - a.gap);
  const risks = gaps.slice(0, 3).map((g) => ({
    label: g.label || skillLabel(g.skillId),
    value: readiness.dimensions[g.skillId]?.score ?? null,
  }));

  const net = deltas.reduce(
    (acc, d) => acc + ((d.after ?? 0) - (d.before ?? 0)),
    0,
  );
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

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <>
            {target.role}{" "}
            <span className="font-normal text-muted">· {target.company}</span>
          </>
        }
        subtitle="Your interview preparation command center."
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

      <ReadinessHero
        overall={readiness.overall}
        confidence={readiness.overallConfidence}
        trend={overallTrend}
        strongest={strongest}
        risks={risks}
        updatedAt={readiness.lastUpdated}
        action={
          <Link to="/readiness">
            <Button variant="secondary" size="small">
              See why
            </Button>
          </Link>
        }
      />

      <NextActionCard
        action={nextAction ? nextAction.action : "You're caught up"}
        why={
          nextAction
            ? [
                <div key="reason">
                  {nextAction.reason || "This skill is a priority for your target role."}
                </div>,
                nextDelta && nextDelta.before !== null && nextDelta.after !== null ? (
                  <div key="delta" className="mt-1">
                    Your last interview moved this from {pct(nextDelta.before)} to{" "}
                    {pct(nextDelta.after)}.
                  </div>
                ) : null,
              ]
            : "No open preparation actions — run a mock interview to add fresh evidence."
        }
        skill={nextAction ? skillLabel(nextAction.skillId) : undefined}
        readiness={nextAction ? nextReadiness : undefined}
        impact={nextAction ? impact : undefined}
        cta={
          nextAction ? (
            <Button onClick={startPractice} disabled={starting}>
              {starting ? "Starting…" : "Start practice"}
            </Button>
          ) : (
            <Link to="/interview">
              <Button>Start mock interview</Button>
            </Link>
          )
        }
      />

      {error ? <ErrorNote error={error} /> : null}

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <SectionHeading
            title="Preparation priorities"
            description="Your biggest gaps right now."
            action={
              <Link to="/prepare">
                <Button variant="ghost" size="small">
                  Open plan
                </Button>
              </Link>
            }
          />
          <PriorityList
            empty="No gaps detected — nice."
            items={gaps.slice(0, 5).map((g) => ({
              key: g.skillId,
              label: g.label || skillLabel(g.skillId),
              statusLabel: g.severity,
              tone: severityTone(g.severity),
              readiness: readiness.dimensions[g.skillId]?.score ?? null,
            }))}
          />
        </Card>

        <Card>
          <SectionHeading
            title="Interview readiness"
            description="Whether another mock interview is worth it yet."
          />
          <div className="space-y-3 text-sm">
            {openActions.length > 0 ? (
              <>
                <p>
                  <strong>{openActions.length}</strong>{" "}
                  {openActions.length === 1 ? "weakness needs" : "weaknesses need"}{" "}
                  preparation first.
                </p>
                <Link to="/prepare">
                  <Button variant="secondary">Practice first</Button>
                </Link>
              </>
            ) : improvedCount > 0 ? (
              <>
                <p>
                  You improved <strong>{improvedCount}</strong>{" "}
                  {improvedCount === 1 ? "skill" : "skills"} in your last interview.
                </p>
                <Link to="/interview">
                  <Button>Start mock interview</Button>
                </Link>
              </>
            ) : (
              <>
                <p className="text-muted">
                  Run a mock interview to find out where you stand.
                </p>
                <Link to="/interview">
                  <Button>Start mock interview</Button>
                </Link>
              </>
            )}
          </div>
        </Card>
      </div>

      <PluginSlot slot="dashboard.cards" />

      <Card>
        <SectionHeading
          title="Recent progress"
          description={
            lastSession
              ? `Changes from your last interview · ${new Date(lastSession.createdAt).toLocaleDateString()}`
              : "How your readiness is moving."
          }
          action={
            lastSession ? (
              <Link to={`/interview/${lastSession.id}`}>
                <Button variant="ghost" size="small">
                  View session
                </Button>
              </Link>
            ) : undefined
          }
        />
        <DeltaList
          empty="No interview evidence yet — run one to start tracking change."
          items={deltas.map((d) => ({
            key: d.skillId,
            label: d.label,
            before: d.before,
            after: d.after,
          }))}
        />
      </Card>

      {metrics && (
        <Card data-testid="progress-card">
          <SectionHeading title="Progress" description="Across all your practice." />
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric
              label="Loops completed"
              value={`${metrics.loopsCompleted}/${metrics.loopsStarted}`}
              title="Interview loops finished (abandoned loops don't count as completed)."
            />
            <Metric
              label="Modes used"
              value={Object.keys(metrics.sessionsPerMode)
                .filter((m) => metrics.sessionsPerMode[m] > 0)
                .length.toString()}
              title={`Sessions per mode: ${
                Object.entries(metrics.sessionsPerMode)
                  .map(([m, n]) => `${m} ×${n}`)
                  .join(", ") || "none"
              }`}
            />
            <Metric
              label="Weakness retest"
              value={
                metrics.weaknessRetestRate.rate === null
                  ? "—"
                  : `${Math.round(metrics.weaknessRetestRate.rate * 100)}%`
              }
              title={`Skills that scored weak in an interview and were asked again later (same or related skill): ${metrics.weaknessRetestRate.retested}/${metrics.weaknessRetestRate.weakSkills}.`}
            />
            <Metric
              label="Improvement after prep"
              value={
                metrics.improvementAfterPrep === null
                  ? "—"
                  : `${metrics.improvementAfterPrep >= 0 ? "+" : ""}${Math.round(
                      metrics.improvementAfterPrep * 100,
                    )}%`
              }
              title="Mean change in evidence scores for a skill after finishing its prep action."
            />
            <Metric
              label="Prep completion"
              value={
                metrics.prepCompletionRate.rate === null
                  ? "—"
                  : `${Math.round(metrics.prepCompletionRate.rate * 100)}%`
              }
              title={`Prep actions marked done: ${metrics.prepCompletionRate.done}/${metrics.prepCompletionRate.total}.`}
            />
            <Metric
              label="Readiness coverage"
              value={
                metrics.readinessCoverage.rate === null
                  ? "—"
                  : `${Math.round(metrics.readinessCoverage.rate * 100)}%`
              }
              title={`Required skills with an evidence-backed readiness score (confidence ≥ 40%): ${metrics.readinessCoverage.covered}/${metrics.readinessCoverage.total}.`}
            />
          </dl>
        </Card>
      )}

      <PluginSlot slot="dashboard.sidebar" />
    </div>
  );
}
