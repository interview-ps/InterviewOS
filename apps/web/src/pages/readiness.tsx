import { useSearchParams } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SkillDetail, type SkillReadiness } from "@/lib/api";
import { Sparkline } from "@/components/sparkline";
import { Bar, Card, CardTitle, ErrorNote, PageHeader, Pill, Skeleton, SkeletonCard, StatusPill, skillLabel } from "@/components/ui";

function scoreTone(s: SkillReadiness): "green" | "blue" | "amber" | "muted" {
  return s.status === "strong" ? "green" : s.status === "developing" ? "blue" : s.status === "weak" ? "amber" : "muted";
}

function TreeNode({
  node,
  all,
  depth,
  selected,
  onSelect,
}: {
  node: SkillReadiness;
  all: Record<string, SkillReadiness>;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const kids = node.children.map((c) => all[c]).filter((c): c is SkillReadiness => Boolean(c));
  return (
    <li>
      <div
        className={`flex items-center gap-2 rounded-[0.6rem] px-2 py-1.5 ${selected === node.skillId ? "bg-tint" : ""}`}
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
      >
        {kids.length > 0 ? (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Toggle ${node.label}`} className="w-4 text-muted">
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4" aria-hidden />
        )}
        <button
          onClick={() => onSelect(node.skillId)}
          data-skill={node.skillId}
          aria-label={node.label || node.skillId}
          className="grid flex-1 grid-cols-[minmax(0,1fr)_8rem_auto_auto] items-center gap-2 text-left"
        >
          <span className="truncate text-sm">{node.label || node.skillId}</span>
          <Bar value={node.score ?? 0} tone={scoreTone(node)} />
          <span className="w-10 text-right text-xs text-muted">
            {node.score === null ? "—" : `${Math.round(node.score * 100)}%`}
          </span>
          <StatusPill status={node.status} />
        </button>
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <TreeNode key={k.skillId} node={k} all={all} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function Readiness() {
  const [params] = useSearchParams();
  const [graph, setGraph] = useState<Record<string, SkillReadiness> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const preselected = useRef(false);

  useEffect(() => {
    api.readiness().then((g) => setGraph(g.dimensions)).catch((e) => setError(e));
  }, []);

  const roots = useMemo(() => {
    if (!graph) return [];
    const isChild = new Set(Object.values(graph).flatMap((n) => n.children));
    return Object.values(graph).filter((n) => !isChild.has(n.skillId));
  }, [graph]);

  const select = useCallback((id: string) => {
    setSelected(id);
    setDetail(null);
    api.skillDetail(id).then(setDetail).catch((e) => setError(e));
  }, []);

  // §9.7: ?skill=<id> (e.g. from the command palette) preselects the panel.
  useEffect(() => {
    if (preselected.current || !graph) return;
    const skill = params.get("skill");
    if (skill && graph[skill]) {
      preselected.current = true;
      select(skill);
    }
  }, [graph, params, select]);

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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Readiness"
        subtitle="Every score below is backed by evidence — click a skill to see why."
      />
      <ErrorNote error={error} />
      {graph && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardTitle>Skill tree</CardTitle>
            <ul>
              {roots.map((r) => (
                <TreeNode key={r.skillId} node={r} all={graph} depth={0} selected={selected} onSelect={select} />
              ))}
            </ul>
          </Card>

          <Card>
            <CardTitle>
              {selected ? (detail?.readiness?.label ?? skillLabel(selected)) : "Select a skill"}
            </CardTitle>
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
                <div>
                  <h3 className="text-sm font-semibold text-navy">Why the system believes this</h3>
                  {detail.evidence.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">No evidence recorded for this skill.</p>
                  ) : (
                    <ul className="mt-1 space-y-2">
                      {detail.evidence.map((ev) => (
                        <li key={ev.id} className="rounded-[0.6rem] border border-line p-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Pill tone={ev.type === "interview_answer" ? "blue" : "muted"}>{ev.type}</Pill>
                            <span className="text-muted">score {Math.round(ev.score * 100)}%</span>
                            <span className="text-muted">conf {Math.round(ev.confidence * 100)}%</span>
                            {ev.sessionId && (
                              <a href={`/interview/${ev.sessionId}`} className="text-xs text-blue underline">
                                session
                              </a>
                            )}
                            <span className="ml-auto text-xs text-muted">
                              {new Date(ev.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                          {ev.observation && <p className="mt-1 text-xs text-muted">“{ev.observation}”</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-navy">Score history</h3>
                  <Sparkline points={detail.history.map((h) => h.score)} />
                </div>
                {detail.actions.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-navy">Preparation history</h3>
                    <ul className="mt-1 space-y-1 text-sm text-muted">
                      {detail.actions.map((a) => (
                        <li key={a.id}>· {a.action} <Pill tone="muted">{a.status}</Pill></li>
                      ))}
                    </ul>
                  </div>
                )}
                {detail.recommendedAction && (
                  <div className="rounded-[0.6rem] bg-green-tint p-3 text-sm text-green">
                    Recommended: {detail.recommendedAction.action}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

