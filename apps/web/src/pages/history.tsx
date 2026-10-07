import { Link } from "react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Table } from "antd";
import { api, type HistoryEntry, type HistoryQuestion, type TargetListItem, type InterviewLoop } from "@/lib/api";
import { useAvailableModes } from "@/lib/modes";
import {
  Bar,
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  Pill,
  ScreenToolbar,
  Skeleton,
  SplitPane,
  Workspace,
  displayLabel,
  humanize,
} from "@/components/ui";
import { useAppRefreshEffect } from "@/lib/app-refresh";

const fmtScore = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`;

/** Readiness moves for a session row — the outcome, not the metadata. */
function rowDeltas(
  e: HistoryEntry,
): { skillId: string; label: string; before: number | null; after: number | null }[] {
  const map = new Map<string, { before: number | null; after: number | null }>();
  for (const q of e.questions ?? []) {
    for (const d of q.readinessDelta ?? []) {
      const cur = map.get(d.skillId);
      if (!cur) map.set(d.skillId, { before: d.before, after: d.after });
      else cur.after = d.after;
    }
  }
  return [...map]
    .slice(0, 3)
    .map(([skillId, v]) => ({ skillId, label: displayLabel(skillId), ...v }));
}

function QuestionNode({ node, depth = 0 }: { node: HistoryQuestion; depth?: number }) {
  const ev = node.evaluation;
  // evaluations saved before modes existed can lack `rubric` / `readinessDelta`
  const rubric = ev?.rubric ?? [];
  const readinessDelta = node.readinessDelta ?? [];
  return (
    <div
      className={`rounded-[var(--radius-sm)] border p-2.5 text-[13px] ${
        node.weak ? "border-red-200 bg-red-50/60" : "border-line bg-page"
      } ${depth > 0 ? "ml-4" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {node.question.followUpOf && (
          <Pill tone="amber">
            follow-up{node.question.followUpFocus ? `: ${node.question.followUpFocus}` : ""}
          </Pill>
        )}
        <Pill tone="muted">{displayLabel(node.question.skillId)}</Pill>
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
        <div className="mt-1.5">
          <p className="text-muted">“{node.answer.text}”</p>
          {node.answer.code && (
            <pre className="mt-1 overflow-x-auto rounded bg-navy/90 p-2 text-xs text-white">
              <code>{node.answer.code}</code>
            </pre>
          )}
          {node.answer.voice && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid="voice-hints">
              <span>delivery:</span>
              {node.answer.voice.feedback.signals.map((s) => (
                <Pill key={s.id} tone={s.status === "ok" ? "green" : "amber"}>
                  {humanize(s.id)}
                </Pill>
              ))}
            </div>
          )}
        </div>
      )}
      {ev && (
        <div className="mt-1.5">
          <p className="text-xs text-muted">{ev.summary}</p>
          {rubric.length > 0 && (
            <dl className="mt-1.5 space-y-1">
              {rubric.map((d) => (
                <div key={d.id} className="flex items-center gap-2">
                  <dt className="w-32 shrink-0 truncate text-xs text-muted">{d.label}</dt>
                  <dd className="w-24 shrink-0">
                    <Bar value={d.score} tone={d.score < 0.5 ? "amber" : d.score >= 0.75 ? "green" : "blue"} />
                  </dd>
                  <dd className="text-xs text-muted">{fmtScore(d.score)}</dd>
                </div>
              ))}
            </dl>
          )}
          {readinessDelta.length > 0 && (
            <p className="mt-1.5 text-xs text-muted">
              Readiness:{" "}
              {readinessDelta
                .map((d) => `${displayLabel(d.skillId)} ${fmtScore(d.before)}→${fmtScore(d.after)}`)
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryEntry | null>(null);
  const [targets, setTargets] = useState<TargetListItem[]>([]);
  const [loops, setLoops] = useState<InterviewLoop[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState("");
  const [targetId, setTargetId] = useState("");
  const [loopId, setLoopId] = useState("");
  const [weakOnly, setWeakOnly] = useState(false);
  const available = useAvailableModes();

  const modeOptions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const m of available) labels.set(m.id, m.label);
    labels.set("mixed", "Mixed (legacy)");
    for (const e of entries ?? []) {
      const id = e.session.roundType;
      if (!labels.has(id)) {
        labels.set(id, e.session.modeLabel ?? id.replace(/[-_]+/g, " "));
      }
    }
    return [["", "All modes"], ...labels.entries()] as [string, string][];
  }, [available, entries]);

  const load = useCallback(() => {
    api
      .history({
        mode: mode || undefined,
        targetId: targetId || undefined,
        loopId: loopId || undefined,
        weakOnly,
      })
      .then((rows) => {
        setEntries(rows);
        setSelectedId(rows[0]?.session.id ?? null);
      })
      .catch((e) => setError(e));
  }, [mode, targetId, loopId, weakOnly]);

  useEffect(() => {
    load();
  }, [load]);
  useAppRefreshEffect(load);
  useEffect(() => {
    api.listTargets().then(setTargets).catch(() => {});
    api.loops().then(setLoops).catch(() => {});
  }, []);

  const select = (id: string) => {
    setSelectedId(id);
    setDetail(null);
    api.sessionHistory(id).then(setDetail).catch((e) => setError(e));
  };

  const clearFilters = () => {
    setMode("");
    setTargetId("");
    setLoopId("");
    setWeakOnly(false);
  };
  const filtered = mode || targetId || loopId || weakOnly;

  if (!entries && !error) {
    return (
      <Workspace toolbar={<ScreenToolbar title="History" />} bodyClassName="space-y-3">
        <Skeleton className="h-40 w-full" />
      </Workspace>
    );
  }

  const selected = (entries ?? []).find((e) => e.session.id === selectedId) ?? null;
  const columns = [
    {
      title: "Session",
      key: "session",
      render: (_: unknown, e: HistoryEntry) => (
        <span className="text-[13px] font-medium text-ink">
          {e.session.mode === "practice"
            ? "Practice session"
            : `${e.session.modeLabel ?? displayLabel(e.session.roundType)} interview`}
        </span>
      ),
    },
    {
      title: "Target",
      key: "target",
      width: 150,
      render: (_: unknown, e: HistoryEntry) => (
        <span className="text-xs text-muted">{e.target ? `${e.target.role} · ${e.target.company}` : "—"}</span>
      ),
    },
    {
      title: "Date",
      key: "date",
      width: 110,
      render: (_: unknown, e: HistoryEntry) => (
        <span className="text-xs text-muted">{new Date(e.session.createdAt).toLocaleDateString()}</span>
      ),
    },
    {
      title: "Outcome",
      key: "outcome",
      width: 130,
      render: (_: unknown, e: HistoryEntry) => (
        <Pill tone={e.hasWeakAnswer ? "amber" : "green"}>
          {e.hasWeakAnswer ? "Needs improvement" : "Completed"}
        </Pill>
      ),
    },
    {
      title: "Questions",
      key: "questions",
      width: 100,
      render: (_: unknown, e: HistoryEntry) => (
        <span className="text-xs text-muted">{(e.questions ?? []).length}</span>
      ),
    },
  ];

  return (
    <Workspace
      scroll={false}
      toolbar={
        <ScreenToolbar
          title="History"
          subtitle="Every session, question, answer and debrief — filter to review weak answers."
          actions={
            filtered ? (
              <Button variant="ghost" size="small" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      }
    >
      <ErrorNote error={error} />

      <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2 text-[13px]">
        <select aria-label="Filter by mode" value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1">
          {modeOptions.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <select aria-label="Filter by target" value={targetId} onChange={(e) => setTargetId(e.target.value)} className="rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1">
          <option value="">All targets</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.role} — {t.company}</option>
          ))}
        </select>
        <select aria-label="Filter by loop" value={loopId} onChange={(e) => setLoopId(e.target.value)} className="rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1">
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

      {entries?.length === 0 ? (
        <div className="mt-3 max-w-3xl">
          <Panel>
            <EmptyState
              title="No past interviews match these filters"
              description="Run an interview or loosen the filters above."
              action={
                <Link to="/interview">
                  <Button variant="secondary" size="small">Start an interview</Button>
                </Link>
              }
            />
          </Panel>
        </div>
      ) : (
        <SplitPane
          leftWidth="58%"
          className="mt-3 flex-1"
          left={
            <Panel className="flex-1" padded={false}>
              <Table
                size="small"
                rowKey={(e) => e.session.id}
                columns={columns}
                dataSource={entries ?? []}
                pagination={false}
                onRow={(e) => ({
                  onClick: () => select(e.session.id),
                  style: { cursor: "pointer" },
                })}
                rowClassName={(e) => (e.session.id === selectedId ? "ant-table-row-selected" : "")}
              />
            </Panel>
          }
          right={
            <Panel
              className="flex-1"
              title={selected ? "Session detail" : "Select a session"}
            >
              {!selected && (
                <EmptyState title="Select a session" description="Pick a row to review its questions and feedback." />
              )}
              {selected && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    {selected.session.mode === "practice" && <Pill tone="amber">Practice</Pill>}
                    <Pill tone={selected.session.status === "debrief" ? "green" : "muted"}>
                      {displayLabel(selected.session.status)}
                    </Pill>
                    {selected.target && (
                      <Pill tone="muted">{humanize(selected.target.companyProfileId)} profile</Pill>
                    )}
                    {selected.loop && (
                      <Pill tone="blue">loop round {selected.loop.round}/{selected.loop.totalRounds}</Pill>
                    )}
                    {selected.hasWeakAnswer && <Pill tone="red">weak answer</Pill>}
                    {rowDeltas(selected).map((d) => (
                      <span key={d.skillId}>
                        {d.label}{" "}
                        {d.before !== null && d.after !== null ? (d.after >= d.before ? "↑" : "↓") : ""}
                      </span>
                    ))}
                    <Link to={`/interview/${selected.session.id}`} className="ml-auto text-blue underline">
                      Open session
                    </Link>
                  </div>

                  {!detail && <Skeleton className="h-24 w-full" />}
                  {(detail?.questions ?? []).map((m) => (
                    <div key={m.question.id} className="space-y-1.5">
                      <QuestionNode node={m} />
                      {(m.followUps ?? []).map((f) => (
                        <QuestionNode key={f.question.id} node={f} depth={1} />
                      ))}
                    </div>
                  ))}
                  {detail && (detail.actionsCreated ?? []).length > 0 && (
                    <div className="rounded-[var(--radius-sm)] bg-page p-2.5 text-[13px]">
                      <p className="font-medium text-ink">Prep actions created</p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                        {(detail.actionsCreated ?? []).map((a) => (
                          <li key={a.id}>
                            {a.action} <span className="text-blue">({displayLabel(a.skillId)})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {detail?.debrief && (
                    <div className="rounded-[var(--radius-sm)] bg-green-tint p-2.5 text-[13px]">
                      <p className="font-medium text-green">Debrief</p>
                      <p className="mt-1">{detail.debrief.summary}</p>
                    </div>
                  )}
                </div>
              )}
            </Panel>
          }
        />
      )}
    </Workspace>
  );
}
