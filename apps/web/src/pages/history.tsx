import { Link } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { api, type HistoryEntry, type HistoryQuestion, type TargetListItem, type InterviewLoop } from "@/lib/api";
import { Bar, Button, Card, CardTitle, EmptyState, ErrorNote, PageHeader, Pill, SkeletonCard, Spinner, skillLabel } from "@/components/ui";

const MODE_OPTIONS = [
  ["", "All modes"],
  ["technical", "Technical"],
  ["coding", "Coding"],
  ["system_design", "System design"],
  ["behavioral", "Behavioral"],
  ["hiring_manager", "Hiring manager"],
  ["hr", "HR"],
  ["mixed", "Mixed (legacy)"],
] as const;

const fmtScore = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`;

function QuestionNode({ node, depth = 0 }: { node: HistoryQuestion; depth?: number }) {
  const ev = node.evaluation;
  // evaluations saved before modes existed can lack `rubric` / `readinessDelta`
  const rubric = ev?.rubric ?? [];
  const readinessDelta = node.readinessDelta ?? [];
  return (
    <div
      className={`rounded-[0.6rem] p-3 text-sm ${node.weak ? "bg-red-50/60 border border-red-200" : "bg-page"} ${depth > 0 ? "ml-5 border-l-2 border-l-line" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {node.question.followUpOf && <Pill tone="amber">follow-up{node.question.followUpFocus ? `: ${node.question.followUpFocus}` : ""}</Pill>}
        <Pill tone="muted">{skillLabel(node.question.skillId)}</Pill>
        {node.weak && <Pill tone="red">weak</Pill>}
      </div>
      <p className="mt-1 font-medium">{node.question.text}</p>
      {node.question.extra?.problem && typeof node.question.extra.problem === "object" && (
        <p className="mt-1 text-xs text-muted">Problem: {node.question.extra.problem.title}</p>
      )}
      {node.question.extra?.problem && typeof node.question.extra.problem === "string" && (
        <p className="mt-1 text-xs text-muted">Design: {node.question.extra.problem}</p>
      )}
      {node.answer && (
        <div className="mt-2">
          <p className="text-muted">“{node.answer.text}”</p>
          {node.answer.code && (
            <pre className="mt-1 overflow-x-auto rounded bg-navy/90 p-2 text-xs text-white">
              <code>{node.answer.code}</code>
            </pre>
          )}
          {node.answer.language && (
            <p className="mt-0.5 text-xs text-muted">language: {node.answer.language}</p>
          )}
        </div>
      )}
      {ev && (
        <div className="mt-2">
          <p className="text-xs text-muted">{ev.summary}</p>
          {rubric.length > 0 && (
            <dl className="mt-2 space-y-1">
              {rubric.map((d) => (
                <div key={d.id} className="flex items-center gap-2">
                  <dt className="w-36 shrink-0 truncate text-xs text-muted">{d.label}</dt>
                  <dd className="w-24 shrink-0">
                    <Bar value={d.score} tone={d.score < 0.5 ? "amber" : d.score >= 0.75 ? "green" : "blue"} />
                  </dd>
                  <dd className="text-xs text-muted">{fmtScore(d.score)}</dd>
                </div>
              ))}
            </dl>
          )}
          {readinessDelta.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              Readiness:{" "}
              {readinessDelta
                .map((d) => `${skillLabel(d.skillId)} ${fmtScore(d.before)}→${fmtScore(d.after)}`)
                .join(" · ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryEntry | null>(null);
  const [targets, setTargets] = useState<TargetListItem[]>([]);
  const [loops, setLoops] = useState<InterviewLoop[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState("");
  const [targetId, setTargetId] = useState("");
  const [loopId, setLoopId] = useState("");
  const [weakOnly, setWeakOnly] = useState(false);

  const load = useCallback(() => {
    api
      .history({
        mode: mode || undefined,
        targetId: targetId || undefined,
        loopId: loopId || undefined,
        weakOnly,
      })
      .then(setEntries)
      .catch((e) => setError(e));
  }, [mode, targetId, loopId, weakOnly]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api.listTargets().then(setTargets).catch(() => {});
    api.loops().then(setLoops).catch(() => {});
  }, []);

  const toggle = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(id);
    setDetail(null);
    api.sessionHistory(id).then(setDetail).catch((e) => setError(e));
  };

  if (!entries && !error) {
    return (
      <div className="space-y-4">
        <PageHeader title="History" />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="History"
        subtitle="Every session, question, answer and debrief — filter to review weak answers."
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <select
            aria-label="Filter by mode"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="rounded border border-line bg-white px-2 py-1"
          >
            {MODE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <select
            aria-label="Filter by target"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="rounded border border-line bg-white px-2 py-1"
          >
            <option value="">All targets</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>{t.role} — {t.company}</option>
            ))}
          </select>
          <select
            aria-label="Filter by loop"
            value={loopId}
            onChange={(e) => setLoopId(e.target.value)}
            className="rounded border border-line bg-white px-2 py-1"
          >
            <option value="">All loops</option>
            {loops.map((l) => (
              <option key={l.id} value={l.id}>
                Loop {new Date(l.createdAt).toLocaleDateString()}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={weakOnly}
              onChange={(e) => setWeakOnly(e.target.checked)}
              data-testid="weak-only"
            />
            Weak answers only
          </label>
        </div>
      </Card>
      <ErrorNote error={error} />
      {entries?.length === 0 && (
        <Card>
          <EmptyState
            title="No past interviews match these filters"
            description="Run an interview or loosen the filters above."
            action={
              <Link to="/interview">
                <Button variant="secondary">Start an interview</Button>
              </Link>
            }
          />
        </Card>
      )}
      {entries?.map((e) => (
        <Card key={e.session.id}>
          <button onClick={() => toggle(e.session.id)} aria-expanded={expanded === e.session.id} className="w-full text-left">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{new Date(e.session.createdAt).toLocaleString()}</span>
              <Pill tone="blue">{e.session.modeLabel ?? e.session.roundType}</Pill>
              {e.session.mode === "practice" && <Pill tone="amber">Practice</Pill>}
              {e.target && (
                <span className="text-sm text-muted">{e.target.role} — {e.target.company}</span>
              )}
              {e.target && <Pill tone="muted">{e.target.companyProfileId} profile</Pill>}
              {e.loop && (
                <Pill tone="blue">loop round {e.loop.round}/{e.loop.totalRounds}</Pill>
              )}
              {e.hasWeakAnswer && <Pill tone="red">weak answer</Pill>}
              <Pill tone={e.session.status === "debrief" ? "green" : "muted"}>{e.session.status}</Pill>
              <span className="text-sm text-muted">{(e.questions ?? []).length} questions</span>
              <span className="ml-auto text-muted" aria-hidden>{expanded === e.session.id ? "▾" : "▸"}</span>
            </div>
          </button>
          {expanded === e.session.id && (
            <div className="mt-3 space-y-3 border-t border-line pt-3">
              {expanded === e.session.id && !detail && <Spinner />}
              {(detail?.questions ?? []).map((m) => (
                <div key={m.question.id}>
                  <QuestionNode node={m} />
                  {(m.followUps ?? []).map((f) => (
                    <div key={f.question.id} className="mt-1.5">
                      <QuestionNode node={f} depth={1} />
                    </div>
                  ))}
                </div>
              ))}
              {detail && (detail.actionsCreated ?? []).length > 0 && (
                <div className="rounded-[0.6rem] bg-page p-3 text-sm">
                  <p className="font-medium text-ink">Prep actions created</p>
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                    {(detail.actionsCreated ?? []).map((a) => (
                      <li key={a.id}>
                        {a.action} <span className="text-blue">({skillLabel(a.skillId)})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {detail?.debrief && (
                <div className="rounded-[0.6rem] bg-green-tint p-3 text-sm">
                  <p className="font-medium text-green">Debrief</p>
                  <p className="mt-1">{detail.debrief.summary}</p>
                </div>
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
