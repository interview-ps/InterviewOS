import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Drawer } from "antd";
import {
  api,
  type PluginSuggestionGroup,
  type PrepAction,
  type PrepResource,
} from "@/lib/api";
import {
  Button,
  DataRow,
  displayLabel,
  EmptyState,
  ErrorNote,
  ExtensionRegion,
  Panel,
  Pill,
  ScreenToolbar,
  SkeletonCard,
  SplitPane,
  toast,
  Workspace,
} from "@/components/ui";
import { PluginSlot, useUIContributions } from "@/components/plugin-ui";
import { useDesktop } from "@/lib/responsive";
import { PrepareTabs } from "./tabs";

const ACTION_STATUS: Record<string, string> = {
  open: "open",
  in_progress: "in progress",
  done: "done",
  superseded: "superseded",
};

/** Backend reasons are API-facing; the queue shows one plain sentence. */
function conciseReason(reason?: string): string | null {
  if (!reason) return null;
  const first = reason.split(/[;.]/)[0]?.trim();
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const isHttps = (u: unknown): u is string =>
  typeof u === "string" && u.startsWith("https://");

function Resources({
  action,
  busy,
  canFetch,
  onChanged,
  onPractice,
  run,
}: {
  action: PrepAction;
  busy: boolean;
  canFetch: boolean;
  onChanged: () => void;
  onPractice: () => void;
  run: (id: string, fn: () => Promise<unknown>) => void;
}) {
  const resources = (action as PrepAction & { resources?: PrepResource[] }).resources ?? [];
  if (resources.length === 0 && !canFetch) return null;
  return (
    <details className="mt-3" data-testid={`resources-${action.id}`}>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
        Resources {resources.length > 0 ? `(${resources.length})` : ""}
      </summary>
      {resources.length > 0 && (
        <ul className="mt-1 space-y-1">
          {resources.map((r, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
              <Pill tone="muted">{r.kind}</Pill>
              {r.kind === "practice" ? (
                <button
                  type="button"
                  onClick={onPractice}
                  disabled={busy}
                  className="text-blue underline"
                >
                  {r.title}
                </button>
              ) : isHttps(r.url) ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue underline"
                >
                  {r.title}
                </a>
              ) : (
                <span className="font-medium text-ink">{r.title}</span>
              )}
              <span className="text-muted">{r.source}</span>
              {r.summary && <span className="w-full text-muted">{r.summary}</span>}
            </li>
          ))}
        </ul>
      )}
      {canFetch && (
        <button
          type="button"
          disabled={busy}
          data-testid={`find-resources-${action.id}`}
          onClick={() =>
            run(action.id, () => api.fetchActionResources(action.id).then(onChanged))
          }
          className="mt-1 text-xs text-blue underline"
        >
          Find more resources
        </button>
      )}
    </details>
  );
}

/** Compact Learn → Practice → Verify indicator (explanatory, not interactive). */
function StageIndicator({ status }: { status: string }) {
  const steps = ["Learn", "Practice", "Verify"];
  const active = status === "open" ? 0 : status === "done" ? 3 : 1;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted">Progress</span>
      <ol
        aria-label="Task progress"
        className="flex flex-wrap items-center gap-1.5 text-xs text-muted"
      >
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border text-[0.65rem] ${
                i < active
                  ? "border-green bg-green-tint text-green"
                  : i === active
                    ? "border-blue text-blue"
                    : "border-line"
              }`}
            >
              {i + 1}
            </span>
            <span className={i === active ? "text-ink" : ""}>{s}</span>
            {i < steps.length - 1 && (
              <span aria-hidden className="mx-0.5">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** General plugin suggestions — kept out of the task's core body, collapsed. */
function TaskExtensions({
  suggestions,
  skillId,
}: {
  suggestions?: ReactNode;
  skillId: string;
}) {
  const contributions = useUIContributions();
  const hasSlot = contributions.some(
    (p) => (p.slots["prepare.activities"] ?? []).length > 0,
  );
  if (!suggestions && !hasSlot) return null;
  return (
    <ExtensionRegion
      title="Suggestions from extensions"
      hint="plugins"
      description="General practices and plugin-recommended exercises — not part of this task's checklist."
    >
      {suggestions}
      {hasSlot && <PluginSlot slot="prepare.activities" params={{ skillId }} />}
    </ExtensionRegion>
  );
}

function ActionDetail({
  action,
  history,
  busy,
  canFetchResources,
  onChanged,
  suggestions,
  run,
}: {
  action: PrepAction;
  history: PrepAction[];
  busy: boolean;
  canFetchResources: boolean;
  onChanged: () => void;
  suggestions?: ReactNode;
  run: (id: string, fn: () => Promise<unknown>) => void;
}) {
  const navigate = useNavigate();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);
  const a = action;

  const toggle = (c: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const markDone = () =>
    run(a.id, () =>
      api.completeAction(a.id, [...checked]).then(() => {
        toast("Action marked done");
        onChanged();
      }),
    );

  const practice = () =>
    run(a.id, () =>
      api
        .startInterview({ mode: "practice", focusSkillId: a.skillId, actionId: a.id })
        .then((r) => r.session && navigate(`/interview/${r.session.id}`)),
    );

  const startPrep = () =>
    run(a.id, () => api.updateAction(a.id, "in_progress").then(onChanged));

  const [summary, ...restParts] = a.action.split(/(?<=\.)\s+/);
  const rest = restParts.join(" ").trim();

  return (
    <Panel
      className="flex-1"
      bodyClassName="space-y-3"
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {a.status === "open" && (
            <Button size="small" disabled={busy} onClick={startPrep}>
              Start preparation
            </Button>
          )}
          {a.status === "in_progress" && (
            <Button size="small" disabled={busy} onClick={practice}>
              Practice this skill
            </Button>
          )}
          <Button variant="secondary" size="small" disabled={busy} onClick={markDone}>
            {busy
              ? "Working…"
              : `Mark done${checked.size ? ` (${checked.size}/${a.successCriteria.length})` : ""}`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={a.priority === 1 ? "amber" : "muted"}>#{a.priority}</Pill>
        <span className="text-sm font-semibold text-navy">{displayLabel(a.skillId)}</span>
        <Pill tone={a.status === "in_progress" ? "blue" : "muted"}>
          {ACTION_STATUS[a.status]}
        </Pill>
      </div>

      <p className="text-sm">{summary}</p>
      {a.reason && <p className="text-xs text-muted">{a.reason}</p>}
      {rest && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Show full task</summary>
          <p className="mt-1">{rest}</p>
        </details>
      )}

      <StageIndicator status={a.status} />
      <p className="text-xs text-muted">
        Start preparation marks this task in progress and unlocks practice. Mark done records
        your self-check — verified readiness comes from interviews and practice answers.
      </p>

      <fieldset className="space-y-1">
        <legend className="sr-only">Success criteria for {a.action}</legend>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          You'll know it's done when
        </p>
        {a.successCriteria.map((c, i) => (
          <label key={i} className="flex items-start gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={checked.has(c)}
              onChange={() => toggle(c)}
              className="mt-0.5 accent-accent"
            />
            <span>{c}</span>
          </label>
        ))}
      </fieldset>

      <Resources
        action={a}
        busy={busy}
        canFetch={canFetchResources}
        onChanged={onChanged}
        onPractice={practice}
        run={run}
      />

      {history.length > 0 && (
        <div className="border-t border-line pt-2">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            className="flex items-center gap-1 text-sm font-semibold text-navy"
          >
            History ({history.length})
            <span aria-hidden className="text-muted">
              {showHistory ? "▾" : "▸"}
            </span>
          </button>
          {showHistory && (
            <ul className="mt-1 space-y-1 text-sm">
              {history.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center justify-between gap-2 border-t border-line pt-1"
                >
                  <span className="min-w-0 flex-1 truncate text-muted">{h.action}</span>
                  <Pill tone={h.status === "done" ? "green" : "muted"}>
                    {ACTION_STATUS[h.status]}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <TaskExtensions suggestions={suggestions} skillId={a.skillId} />
    </Panel>
  );
}

export default function PrepPlan() {
  const [actions, setActions] = useState<PrepAction[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [canFetchResources, setCanFetchResources] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const desktop = useDesktop();

  const load = useCallback(() => {
    api.preparation().then((p) => setActions(p.actions)).catch((e) => setError(e));
    api
      .plugins()
      .then((r) =>
        setCanFetchResources(
          r.plugins.some(
            (p) => p.enabled && (p.manifest.capabilities ?? []).includes("resources"),
          ),
        ),
      )
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  // Plugin suggestions live above the keyed detail pane so an accepted
  // suggestion ("Added") survives switching the selected task.
  const [suggestGroups, setSuggestGroups] = useState<PluginSuggestionGroup[]>([]);
  const [suggestAdded, setSuggestAdded] = useState<Set<string>>(new Set());
  const [suggestBusy, setSuggestBusy] = useState<string | null>(null);
  useEffect(() => {
    api
      .pluginPrepSuggestions()
      .then((r) => setSuggestGroups(r.suggestions))
      .catch(() => {});
  }, []);
  const acceptSuggestion = (
    pluginId: string,
    activity: PluginSuggestionGroup["activities"][number],
    key: string,
  ) => {
    setSuggestBusy(key);
    api
      .acceptPluginSuggestion(pluginId, activity)
      .then(() => {
        setSuggestAdded((p) => new Set(p).add(key));
        toast("Added to plan");
        load();
      })
      .catch((e) => setError(e))
      .finally(() => setSuggestBusy(null));
  };

  const recalc = () => {
    setBusy("recalc");
    api
      .recalculatePlan()
      .then(load)
      .catch((e) => setError(e))
      .finally(() => setBusy(null));
  };

  const run = (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    fn()
      .catch((e) => setError(e))
      .finally(() => setBusy(null));
  };

  if (!actions && !error) {
    return (
      <Workspace
        toolbar={<ScreenToolbar title="Prepare" tabs={<PrepareTabs />} />}
        bodyClassName="space-y-3"
      >
        <SkeletonCard />
        <SkeletonCard />
      </Workspace>
    );
  }

  const open = (actions ?? [])
    .filter((a) => a.status === "open" || a.status === "in_progress")
    .sort((a, b) => a.priority - b.priority);
  // The detail pane defaults to the highest-priority action; the queue only
  // changes which one is open, never the action set.
  const selectedAction = open.find((a) => a.id === selectedId) ?? open[0];
  const history = (actions ?? [])
    .filter((a) => a.status === "done" || a.status === "superseded")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const queueList = (
    <div className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-card)] border border-line bg-surface">
      {open.map((a) => (
        <DataRow
          key={a.id}
          selected={a.id === selectedAction?.id}
          onClick={() => {
            setSelectedId(a.id);
            setQueueOpen(false);
          }}
          leading={
            <Pill tone={a.priority === 1 ? "amber" : "muted"}>#{a.priority}</Pill>
          }
          title={displayLabel(a.skillId)}
          meta={
            <>
              {ACTION_STATUS[a.status]}
              {conciseReason(a.reason) ? ` · ${conciseReason(a.reason)}` : ""}
            </>
          }
        />
      ))}
    </div>
  );

  const queuePanel = (
    <>
      <div className="flex shrink-0 items-center justify-between px-1 pb-1.5">
        <span className="text-xs font-semibold text-muted">Task queue</span>
        <span className="text-xs text-muted">{open.length}</span>
      </div>
      {queueList}
    </>
  );

  const detailNode = selectedAction ? (
    <ActionDetail
      key={selectedAction.id}
      action={selectedAction}
      history={history}
      busy={busy === selectedAction.id}
      canFetchResources={canFetchResources}
      onChanged={load}
      suggestions={
        <PluginSuggestions
          groups={suggestGroups}
          added={suggestAdded}
          busy={suggestBusy}
          onAccept={acceptSuggestion}
        />
      }
      run={run}
    />
  ) : null;

  return (
    <Workspace
      scroll={false}
      toolbar={
        <ScreenToolbar
          title="Prepare"
          tabs={<PrepareTabs />}
          actions={
            <>
              <Pill tone="muted">{open.length} open</Pill>
              <Link to="/resume" className="text-[13px] text-blue hover:underline">
                Resume coach
              </Link>
              <Button
                variant="secondary"
                size="small"
                onClick={recalc}
                disabled={busy === "recalc"}
              >
                {busy === "recalc" ? "Refreshing…" : "Refresh"}
              </Button>
            </>
          }
        />
      }
    >
      <ErrorNote error={error} />

      {open.length === 0 && !error ? (
        <Panel className="mt-3 flex-1">
          <EmptyState
            title="No open actions"
            description="Set a target role or recalculate the plan."
            action={
              <Link to="/target">
                <Button variant="secondary" size="small">
                  Open target
                </Button>
              </Link>
            }
          />
        </Panel>
      ) : open.length > 0 ? (
        <>
          {desktop ? (
            <SplitPane
              leftWidth={280}
              className="mt-3 flex-1"
              left={queuePanel}
              right={detailNode}
            />
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  data-testid="open-task-queue"
                  onClick={() => setQueueOpen(true)}
                >
                  Tasks · {open.length}
                </Button>
                {selectedAction && (
                  <span className="min-w-0 truncate text-xs text-muted">
                    {displayLabel(selectedAction.skillId)}
                  </span>
                )}
              </div>
              {detailNode}
            </div>
          )}
          <Drawer
            open={!desktop && queueOpen}
            onClose={() => setQueueOpen(false)}
            placement="bottom"
            size="70%"
            title={`Tasks · ${open.length}`}
            styles={{
              body: { padding: 0, display: "flex", flexDirection: "column" },
            }}
          >
            <div className="min-h-0 flex-1 overflow-auto">{queueList}</div>
          </Drawer>
        </>
      ) : null}
    </Workspace>
  );
}

/** v1: activities suggested by `preparation` plugins — "Add to plan" accepts. */
function PluginSuggestions({
  groups,
  added,
  busy,
  onAccept,
}: {
  groups: PluginSuggestionGroup[];
  added: Set<string>;
  busy: string | null;
  onAccept: (
    pluginId: string,
    activity: PluginSuggestionGroup["activities"][number],
    key: string,
  ) => void;
}) {
  const visible = groups.filter((g) => g.activities.length > 0);
  if (visible.length === 0) return null;
  return (
    <div className="border-t border-line pt-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        Suggestions from plugins
      </p>
      <div className="mt-1.5 space-y-2">
        {visible.map((g) => (
          <div key={g.pluginId}>
            <p className="text-xs text-muted">from plugin {g.pluginName}</p>
            <ul className="mt-1 space-y-1.5">
              {g.activities.map((a, i) => {
                const key = `${g.pluginId}:${i}`;
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] bg-page px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-navy">{a.title}</p>
                      <p className="truncate text-xs text-muted">{a.action}</p>
                    </div>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy === key || added.has(key)}
                      onClick={() => onAccept(g.pluginId, a, key)}
                    >
                      {added.has(key) ? "Added" : "Add to plan"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
