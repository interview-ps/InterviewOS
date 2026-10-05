import { Link, useSearchParams } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Segmented } from "antd";
import {
  api,
  type Metrics,
  type SkillDetail,
  type SkillReadiness,
} from "@/lib/api";
import {
  Bar,
  Button,
  Card,
  DeltaList,
  ErrorNote,
  KeyValueRows,
  PageHeader,
  Pill,
  PriorityList,
  ReadinessHero,
  ScopeNote,
  SectionHeading,
  Skeleton,
  SkeletonCard,
  Sparkline,
  StatusBuckets,
  StatusPill,
  displayLabel,
  pct,
  readinessVerdict,
  severityTone,
} from "@/components/ui";
import { PluginSlot } from "@/components/plugin-ui";

type ReadinessGraph = Awaited<ReturnType<typeof api.readiness>>;

function scoreTone(s: SkillReadiness): "green" | "blue" | "amber" | "muted" {
  return s.status === "strong"
    ? "green"
    : s.status === "developing"
      ? "blue"
      : s.status === "weak"
        ? "amber"
        : "muted";
}

/** Evidence sources carry distinct meaning — never render them all the same. */
const EVIDENCE_SOURCE: Record<
  string,
  { label: string; tone: "blue" | "green" | "amber" | "muted" }
> = {
  interview_answer: { label: "Interview answer", tone: "blue" },
  self_report: { label: "Self report", tone: "muted" },
  resume: { label: "Resume", tone: "green" },
  plugin: { label: "Extension", tone: "amber" },
};

function TreeNode({
  node,
  all,
  depth,
  selected,
  onSelect,
  hideUnknown,
}: {
  node: SkillReadiness;
  all: Record<string, SkillReadiness>;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  hideUnknown: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (hideUnknown && node.status === "unknown") return null;
  const kids = node.children
    .map((c) => all[c])
    .filter((c): c is SkillReadiness => Boolean(c))
    .filter((k) => !(hideUnknown && k.status === "unknown"));
  return (
    <li>
      <div
        className={`flex items-center gap-2 rounded-[0.6rem] px-2 py-1.5 ${
          selected === node.skillId ? "bg-tint" : ""
        }`}
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
      >
        {kids.length > 0 ? (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`Toggle ${displayLabel(node.skillId, node.label)}`}
            className="w-4 text-muted"
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4" aria-hidden />
        )}
        <button
          onClick={() => onSelect(node.skillId)}
          data-skill={node.skillId}
          aria-label={displayLabel(node.skillId, node.label)}
          className="grid flex-1 grid-cols-[minmax(0,1fr)_8rem_3rem_auto] items-center gap-2 text-left"
        >
          <span className="truncate text-sm">{displayLabel(node.skillId, node.label)}</span>
          {node.score === null ? (
            <span className="text-xs text-muted">not assessed</span>
          ) : (
            <Bar value={node.score} tone={scoreTone(node)} />
          )}
          <span className="text-right text-xs text-muted">
            {node.score === null ? "" : pct(node.score)}
          </span>
          {node.score === null ? <span /> : <StatusPill status={node.status} />}
        </button>
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <TreeNode
              key={k.skillId}
              node={k}
              all={all}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              hideUnknown={hideUnknown}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function Readiness() {
  const [params] = useSearchParams();
  const [graph, setGraph] = useState<ReadinessGraph | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [hideUnknown, setHideUnknown] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const preselected = useRef(false);

  useEffect(() => {
    api.readiness().then(setGraph).catch((e) => setError(e));
    api.metrics().then(setMetrics).catch(() => {});
  }, []);

  const dimensions = graph?.dimensions ?? null;

  const roots = useMemo(() => {
    if (!dimensions) return [];
    const isChild = new Set(Object.values(dimensions).flatMap((n) => n.children));
    return Object.values(dimensions).filter((n) => !isChild.has(n.skillId));
  }, [dimensions]);

  const buckets = useMemo(() => {
    const c = { strong: 0, developing: 0, weak: 0, unknown: 0 };
    for (const n of Object.values(dimensions ?? {})) c[n.status] += 1;
    return c;
  }, [dimensions]);

  const weaknesses = useMemo(() => {
    const scored = Object.values(dimensions ?? {}).filter(
      (n) => n.score !== null && (n.status === "weak" || n.status === "developing"),
    );
    return scored.sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 5);
  }, [dimensions]);

  const coverage = metrics?.readinessCoverage ?? null;

  const select = useCallback((id: string) => {
    setSelected(id);
    setDetail(null);
    api.skillDetail(id).then(setDetail).catch((e) => setError(e));
  }, []);

  // §9.7: ?skill=<id> (e.g. from the command palette) preselects the panel.
  useEffect(() => {
    if (preselected.current || !dimensions) return;
    const skill = params.get("skill");
    if (skill && dimensions[skill]) {
      preselected.current = true;
      select(skill);
    }
  }, [dimensions, params, select]);

  if (!graph && !error) {
    return (
      <div className="space-y-5">
        <PageHeader title="Readiness" />
        <div className="grid gap-5 lg:grid-cols-2">
          <SkeletonCard lines={5} />
          <SkeletonCard lines={5} />
        </div>
      </div>
    );
  }

  const historyPoints = (detail?.history ?? []).map((h) => h.score);
  const lowCoverage = coverage !== null && coverage.rate !== null && coverage.rate < 0.5;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Readiness"
        subtitle="Why Interview OS thinks you are ready — or not."
      />
      <ErrorNote error={error} />

      {graph && (
        <>
          <ReadinessHero
            overall={graph.overall}
            confidence={graph.overallConfidence}
            verdict={readinessVerdict(graph.overall, coverage?.rate ?? null)}
            note={
              coverage
                ? `${coverage.covered} of ${coverage.total} required skills have confident evidence.`
                : undefined
            }
            updatedAt={graph.lastUpdated}
          />

          <KeyValueRows
            column={1}
            items={[
              {
                key: "readiness",
                label: "Estimated readiness",
                children: (
                  <>
                    Weighted across your target's <strong>required and preferred</strong>{" "}
                    skills. Skills with no evidence yet are held at a conservative
                    prior, not counted as failures.
                  </>
                ),
              },
              {
                key: "confidence",
                label: "Confidence",
                children: (
                  <>
                    How much evidence supports the score — it is not a measure of how
                    good you are.
                  </>
                ),
              },
              {
                key: "coverage",
                label: "Coverage",
                children: coverage ? (
                  <>
                    {coverage.covered} of {coverage.total} <strong>required</strong>{" "}
                    skills have confident evidence.
                  </>
                ) : (
                  <>No target requirements to measure yet.</>
                ),
              },
            ]}
          />

          {lowCoverage && (
            <Alert
              type="info"
              showIcon
              title="Your score is based on limited evidence"
              description="A short diagnostic interview is the fastest way to raise confidence — it fills in the skills we can only estimate today."
              action={
                <Link to="/interview">
                  <Button size="small">Complete a diagnostic interview</Button>
                </Link>
              }
            />
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <SectionHeading
                title="Where you stand"
                description="Assessed skills, grouped by readiness."
              />
              <StatusBuckets counts={buckets} />
              <div className="mt-2">
                <ScopeNote>
                  Across {Object.keys(dimensions ?? {}).length} skills tracked
                  (required skills plus their prerequisites). Coverage above counts
                  required skills only — the two numbers intentionally differ.
                </ScopeNote>
              </div>

              <div className="mt-5 border-t border-line pt-4">
                <SectionHeading
                  title="Highest-priority weaknesses"
                  description="Required skills with a measured score, lowest first."
                />
                <PriorityList
                  empty="No assessed weaknesses — nice."
                  items={weaknesses.map((n) => ({
                    key: n.skillId,
                    label: displayLabel(n.skillId, n.label),
                    statusLabel: n.status === "weak" ? "needs work" : "improving",
                    tone: severityTone(n.status === "weak" ? "high" : "medium"),
                    readiness: n.score,
                  }))}
                />
                {buckets.unknown > 0 && (
                  <div className="mt-3">
                    <ScopeNote>
                      {buckets.unknown} skills are not assessed yet — missing evidence,
                      not poor performance. A mock interview produces the evidence they
                      need.
                    </ScopeNote>
                  </div>
                )}
              </div>

              <div className="mt-5 border-t border-line pt-4">
                <SectionHeading
                  title="All skills"
                  description={
                    coverage
                      ? `${coverage.covered} of ${coverage.total} assessed.`
                      : undefined
                  }
                  action={
                    <Segmented
                      size="small"
                      value={hideUnknown ? "assessed" : "all"}
                      onChange={(v) => setHideUnknown(v === "assessed")}
                      options={[
                        { value: "all", label: "All" },
                        { value: "assessed", label: "Assessed" },
                      ]}
                    />
                  }
                />
                <ul>
                  {roots.map((r) => (
                    <TreeNode
                      key={r.skillId}
                      node={r}
                      all={graph.dimensions}
                      depth={0}
                      selected={selected}
                      onSelect={select}
                      hideUnknown={hideUnknown}
                    />
                  ))}
                </ul>
              </div>
            </Card>

            <Card>
              <SectionHeading
                title={
                  selected
                    ? displayLabel(selected, detail?.readiness?.label)
                    : "Select a skill"
                }
                description={
                  selected ? undefined : "Pick a skill to see the evidence behind its score."
                }
              />
              {selected && !detail && (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3.5" />
                  <Skeleton className="h-3.5 w-3/4" />
                </div>
              )}
              {detail && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <StatusPill status={detail.readiness?.status ?? "unknown"} />
                    <Pill tone="muted">
                      confidence {Math.round((detail.readiness?.confidence ?? 0) * 100)}%
                    </Pill>
                  </div>

                  {detail.recommendedAction && (
                    <div className="rounded-[0.6rem] bg-green-tint p-3 text-sm text-green">
                      {detail.recommendedAction.action}
                    </div>
                  )}

                  <div>
                    <h3 className="text-sm font-semibold text-navy">
                      Evidence behind this score
                    </h3>
                    {detail.evidence.length === 0 ? (
                      <p className="mt-1 text-sm text-muted">
                        No evidence recorded for this skill yet.
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-2">
                        {detail.evidence.map((ev) => (
                          <li
                            key={ev.id}
                            className="rounded-[0.6rem] border border-line p-3 text-sm"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              {(() => {
                                const src = EVIDENCE_SOURCE[ev.type] ?? {
                                  label: displayLabel(ev.type),
                                  tone: "muted" as const,
                                };
                                return <Pill tone={src.tone}>{src.label}</Pill>;
                              })()}
                              <span className="text-muted">
                                score {Math.round(ev.score * 100)}%
                              </span>
                              {ev.sessionId && (
                                <a
                                  href={`/interview/${ev.sessionId}`}
                                  className="text-xs text-blue underline"
                                >
                                  view session
                                </a>
                              )}
                              <span className="ml-auto text-xs text-muted">
                                {new Date(ev.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                            {ev.observation && (
                              <p className="mt-1 text-xs text-muted">“{ev.observation}”</p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-navy">Score history</h3>
                    <Sparkline points={historyPoints} />
                    {historyPoints.length >= 2 && (
                      <div className="mt-1">
                        <DeltaList
                          items={[
                            {
                              key: "overall",
                              label: "Since first evidence",
                              before: historyPoints[0] ?? null,
                              after: historyPoints[historyPoints.length - 1] ?? null,
                            },
                          ]}
                        />
                      </div>
                    )}
                  </div>

                  {detail.actions.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium text-navy">
                        Preparation history
                      </summary>
                      <ul className="mt-1 space-y-1 text-sm text-muted">
                        {detail.actions.map((a) => (
                          <li key={a.id}>
                            · {a.action}{" "}
                            <Pill tone={a.status === "done" ? "green" : "muted"}>
                              {displayLabel(a.status)}
                            </Pill>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
      <PluginSlot slot="readiness.panels" />
    </div>
  );
}
