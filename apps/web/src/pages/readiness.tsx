import { Link, useSearchParams } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Drawer } from "antd";
import {
  api,
  type Metrics,
  type SkillDetail,
  type SkillReadiness,
} from "@/lib/api";
import {
  Bar,
  DeltaList,
  EmptyState,
  ErrorNote,
  Panel,
  Pill,
  ScreenToolbar,
  Skeleton,
  Sparkline,
  SplitPane,
  StatStrip,
  StatusPill,
  Workspace,
  displayLabel,
  pct,
  readinessVerdict,
} from "@/components/ui";
import { ExtensionSlot } from "@/components/plugin-ui";
import { useDesktop } from "@/lib/responsive";

type ReadinessGraph = Awaited<ReturnType<typeof api.readiness>>;
type FilterMode = "all" | "assessed" | "weak" | "unassessed";
type DetailTab = "evidence" | "history" | "preparation";

const READINESS_SELECT_KEY = "interview-os:readiness-skill";

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
  visible,
}: {
  node: SkillReadiness;
  all: Record<string, SkillReadiness>;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  visible: Set<string>;
}) {
  const [open, setOpen] = useState(true);
  if (!visible.has(node.skillId)) return null;
  const kids = node.children
    .map((c) => all[c])
    .filter((c): c is SkillReadiness => Boolean(c))
    .filter((k) => visible.has(k.skillId));
  return (
    <li>
      <div
        className={`flex items-center gap-2 border-b border-divider px-2 py-1 last:border-b-0 ${
          selected === node.skillId
            ? "bg-[var(--color-tint)] shadow-[inset_2px_0_0_0_var(--color-blue)]"
            : "hover:bg-[var(--color-hover)]"
        }`}
        style={{ paddingLeft: `${depth * 0.55 + 0.5}rem` }}
      >
        {kids.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`Toggle ${displayLabel(node.skillId, node.label)}`}
            className="w-4 shrink-0 text-muted"
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.skillId)}
          data-skill={node.skillId}
          data-testid="skill-row"
          aria-label={displayLabel(node.skillId, node.label)}
          className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_4.5rem_2.5rem_auto] items-center gap-2 text-left"
        >
          <span
            className="truncate text-[13px]"
            title={displayLabel(node.skillId, node.label)}
          >
            {displayLabel(node.skillId, node.label)}
          </span>
          {node.score === null ? (
            <span className="col-span-3 whitespace-nowrap text-xs text-muted">
              not assessed
            </span>
          ) : (
            <>
              <Bar value={node.score} tone={scoreTone(node)} />
              <span className="text-right text-xs tabular-nums text-muted">
                {pct(node.score)}
              </span>
              <StatusPill status={node.status} />
            </>
          )}
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
              visible={visible}
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
  const [filter, setFilter] = useState<FilterMode>("all");
  const [tab, setTab] = useState<DetailTab>("evidence");
  const [error, setError] = useState<unknown>(null);
  const preselected = useRef(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const desktop = useDesktop();

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

  const counts = useMemo(() => {
    const c = { all: 0, assessed: 0, weak: 0, unassessed: 0 };
    for (const n of Object.values(dimensions ?? {})) {
      c.all += 1;
      if (n.score !== null) c.assessed += 1;
      if (n.status === "weak" || n.status === "developing") c.weak += 1;
      if (n.status === "unknown") c.unassessed += 1;
    }
    return c;
  }, [dimensions]);

  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    if (!dimensions) return ids;
    const match = (n: SkillReadiness) =>
      filter === "all"
        ? true
        : filter === "assessed"
          ? n.score !== null
          : filter === "weak"
            ? n.status === "weak" || n.status === "developing"
            : n.status === "unknown";
    const parentOf = (id: string): string | null => {
      const idx = id.lastIndexOf(".");
      if (idx < 0) return null;
      const parent = id.slice(0, idx);
      return dimensions[parent] ? parent : null;
    };
    for (const n of Object.values(dimensions)) {
      if (!match(n)) continue;
      ids.add(n.skillId);
      let p = parentOf(n.skillId);
      while (p) {
        ids.add(p);
        p = parentOf(p);
      }
    }
    return ids;
  }, [dimensions, filter]);

  const coverage = metrics?.readinessCoverage ?? null;

  const select = useCallback((id: string) => {
    setSelected(id);
    setDetail(null);
    setTab("evidence");
    try {
      localStorage.setItem(READINESS_SELECT_KEY, id);
    } catch {
      /* storage unavailable — selection stays in memory */
    }
    api.skillDetail(id).then(setDetail).catch((e) => setError(e));
  }, []);

  // Preselect: ?skill= (command palette) → last viewed skill → highest-priority
  // gap. Never leave the inspector empty when a relevant skill is known.
  useEffect(() => {
    if (preselected.current || !dimensions) return;
    const fromQuery = params.get("skill");
    if (fromQuery && dimensions[fromQuery]) {
      preselected.current = true;
      select(fromQuery);
      return;
    }
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(READINESS_SELECT_KEY);
    } catch {
      stored = null;
    }
    if (stored && dimensions[stored]) {
      preselected.current = true;
      select(stored);
      return;
    }
    preselected.current = true;
    api
      .state()
      .then((s) => {
        const first = s.assessment.gaps[0]?.skillId;
        if (first && dimensions[first]) select(first);
      })
      .catch(() => {});
  }, [dimensions, params, select]);

  if (!graph && !error) {
    return (
      <Workspace toolbar={<ScreenToolbar title="Readiness" />} bodyClassName="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-60 w-full" />
      </Workspace>
    );
  }

  const historyPoints = (detail?.history ?? []).map((h) => h.score);
  const lowCoverage = coverage !== null && coverage.rate !== null && coverage.rate < 0.5;

  const filters: { key: FilterMode; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "assessed", label: "Assessed", count: counts.assessed },
    { key: "weak", label: "Needs work", count: counts.weak },
    { key: "unassessed", label: "Unassessed", count: counts.unassessed },
  ];

  const allDims = graph?.dimensions ?? {};

  // Explicit selection opens the mobile detail Drawer; a background preselect
  // must not auto-open it. (A plain function — not a hook — because this sits
  // below the loading early-return.)
  const onSelectSkill = (id: string) => {
    select(id);
    setDetailOpen(true);
  };

  const filtersRow = (
    <div className="flex shrink-0 flex-wrap items-center gap-1 pb-1.5">
      {filters.map((f) => (
        <button
          key={f.key}
          type="button"
          aria-current={filter === f.key ? "page" : undefined}
          onClick={() => setFilter(f.key)}
          className={`rounded-[var(--radius-sm)] px-2 py-1 text-xs ${
            filter === f.key
              ? "bg-[var(--color-tint)] font-semibold text-navy"
              : "text-muted hover:text-ink"
          }`}
        >
          {f.label} <span className="text-muted">{f.count}</span>
        </button>
      ))}
    </div>
  );

  const listBody = (
    <div
      className={`rounded-[var(--radius-card)] border border-divider bg-surface ${
        desktop ? "min-h-0 flex-1 overflow-auto" : ""
      }`}
    >
      <ul>
        {roots.map((r) => (
          <TreeNode
            key={r.skillId}
            node={r}
            all={allDims}
            depth={0}
            selected={selected}
            onSelect={onSelectSkill}
            visible={visibleIds}
          />
        ))}
      </ul>
      {visibleIds.size === 0 && (
        <p className="p-3 text-sm text-muted">No skills match this filter.</p>
      )}
    </div>
  );

  const detailPanel = (
    <Panel className={desktop ? "flex-1" : "h-full"} padded={false}>
      {!selected && (
        <div className="p-4">
          <EmptyState
            title="Choose a skill"
            description="Pick a skill from the list to see the evidence behind its score. Use the filters to narrow the list."
          />
        </div>
      )}
      {selected && !detail && (
        <div className="space-y-2 p-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      )}
      {detail && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-3 py-2">
            <span className="text-sm font-semibold text-navy">
              {displayLabel(selected!, detail.readiness?.label)}
            </span>
            <StatusPill status={detail.readiness?.status ?? "unknown"} />
            <Pill tone="muted">
              score{" "}
              {detail.readiness?.score === null || detail.readiness?.score === undefined
                ? "—"
                : pct(detail.readiness.score)}
            </Pill>
            <Pill tone="muted">
              confidence {Math.round((detail.readiness?.confidence ?? 0) * 100)}%
            </Pill>
          </div>
          {detail.recommendedAction && (
            <div className="shrink-0 border-s-[3px] border-s-[var(--color-blue)] bg-[var(--color-inset)] px-3 py-2 text-[13px] text-ink">
              {detail.recommendedAction.action}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1 border-b border-divider px-2">
            {(
              [
                ["evidence", "Evidence"],
                ["history", "History"],
                ["preparation", "Preparation"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-current={tab === key ? "page" : undefined}
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-2.5 py-1.5 text-[13px] ${
                  tab === key
                    ? "border-[color:var(--color-blue)] font-semibold text-navy"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {tab === "evidence" && (
              <div>
                <h3 className="text-[13px] font-semibold text-navy">
                  Evidence behind this score
                </h3>
                {detail.evidence.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">
                    No evidence recorded for this skill yet.
                  </p>
                ) : (
                  <ul className="mt-1.5 space-y-1.5">
                    {detail.evidence.map((ev) => {
                      const src = EVIDENCE_SOURCE[ev.type] ?? {
                        label: displayLabel(ev.type),
                        tone: "muted" as const,
                      };
                      return (
                        <li
                          key={ev.id}
                          className="rounded-[var(--radius-sm)] border border-divider p-2.5 text-[13px]"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Pill tone={src.tone}>{src.label}</Pill>
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
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {tab === "history" && (
              <div>
                <h3 className="text-[13px] font-semibold text-navy">Score history</h3>
                <Sparkline points={historyPoints} />
                {historyPoints.length >= 2 ? (
                  <div className="mt-2">
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
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    {historyPoints.length} data point
                    {historyPoints.length === 1 ? "" : "s"} — more evidence shows a trend.
                  </p>
                )}
              </div>
            )}

            {tab === "preparation" && (
              <div>
                <h3 className="text-[13px] font-semibold text-navy">
                  Preparation history
                </h3>
                {detail.actions.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">
                    No preparation actions for this skill yet.
                  </p>
                ) : (
                  <ul className="mt-1.5 space-y-1.5">
                    {detail.actions.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-start justify-between gap-2 text-[13px]"
                      >
                        <span className="text-muted">{a.action}</span>
                        <Pill tone={a.status === "done" ? "green" : "muted"}>
                          {displayLabel(a.status)}
                        </Pill>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );

  return (
    <Workspace
      scroll={false}
      toolbar={
        <ScreenToolbar
          title="Readiness"
          subtitle="Why Interview OS thinks you are ready — or not."
        />
      }
    >
      <ErrorNote error={error} />

      {graph && (
        <>
          <StatStrip
            className="mt-3 shrink-0"
            items={[
              { label: "Estimated readiness", value: pct(graph.overall) },
              { label: "Confidence", value: pct(graph.overallConfidence) },
              {
                label: "Required coverage",
                value: coverage ? `${coverage.covered}/${coverage.total}` : "Not assessed",
              },
              {
                label: "Evidence",
                value: lowCoverage ? "limited" : "sufficient",
                suffix: readinessVerdict(graph.overall, coverage?.rate ?? null),
                action: lowCoverage ? (
                  <Link to="/interview" className="text-blue underline">
                    Complete a diagnostic interview
                  </Link>
                ) : null,
              },
            ]}
          />

          <div className="mt-2 flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted">
            <details className="min-w-0">
              <summary className="cursor-pointer text-blue">What these numbers mean</summary>
              <p className="mt-1 max-w-prose">
                <strong>Estimated readiness</strong> is weighted across your target's{" "}
                <strong>required and preferred</strong> skills; skills with no evidence yet are
                held at a conservative prior, not counted as failures. <strong>Confidence</strong>{" "}
                is how much evidence supports the score — not how good you are.{" "}
                <strong>Coverage</strong> counts{" "}
                {coverage ? `${coverage.covered} of ${coverage.total} ` : ""}
                <strong>required</strong> skills with confident evidence.
              </p>
            </details>
          </div>

          {desktop ? (
            <SplitPane
              leftWidth={360}
              className="mt-3 flex-1"
              left={
                <>
                  {filtersRow}
                  {listBody}
                </>
              }
              right={detailPanel}
            />
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {filtersRow}
              {listBody}
            </div>
          )}

          <Drawer
            open={!desktop && detailOpen}
            onClose={() => setDetailOpen(false)}
            placement="bottom"
            size="85%"
            title="Skill detail"
            styles={{
              body: { padding: 0, display: "flex", flexDirection: "column" },
            }}
          >
            {detailPanel}
          </Drawer>

          <div className="mt-3 shrink-0">
            <ExtensionSlot slot="readiness.panels" />
          </div>
        </>
      )}
    </Workspace>
  );
}
