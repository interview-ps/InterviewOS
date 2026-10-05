import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  api,
  type PluginSuggestionGroup,
  type PrepAction,
  type PrepResource,
} from "@/lib/api";
import {
  Button,
  Callout,
  Card,
  CardTitle,
  EmptyState,
  ErrorNote,
  PageHeader,
  Pill,
  SectionHeading,
  SkeletonCard,
  skillLabel,
  toast,
} from "@/components/ui";
import { PluginSlot } from "@/components/plugin-ui";

const ACTION_STATUS: Record<string, string> = {
  open: "open",
  in_progress: "in progress",
  done: "done",
  superseded: "superseded",
};

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
  return (
    <div className="mt-2" data-testid={`resources-${action.id}`}>
      {resources.length > 0 && (
        <ul className="space-y-1">
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
    </div>
  );
}

function ActionCard({
  action,
  busy,
  canFetchResources,
  onChanged,
  run,
}: {
  action: PrepAction;
  busy: boolean;
  canFetchResources: boolean;
  onChanged: () => void;
  run: (id: string, fn: () => Promise<unknown>) => void;
}) {
  const navigate = useNavigate();
  const [checked, setChecked] = useState<Set<string>>(new Set());
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

  const verify = () =>
    run(a.id, () =>
      api
        .startInterview({ mode: "practice", focusSkillId: a.skillId, actionId: a.id })
        .then((r) => r.session && navigate(`/interview/${r.session.id}`)),
    );

  return (
    <Card className={a.priority === 1 ? "border-accent" : ""}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={a.priority === 1 ? "amber" : "muted"}>#{a.priority}</Pill>
        <span className="font-medium">{skillLabel(a.skillId)}</span>
        <Pill tone={a.status === "in_progress" ? "blue" : "muted"}>
          {ACTION_STATUS[a.status]}
        </Pill>
      </div>
      <p className="mt-2 text-base">{a.action}</p>
      {a.reason && (
        <div className="mt-2">
          <Callout title="Why this matters">{a.reason}</Callout>
        </div>
      )}
      <fieldset className="mt-3 space-y-1">
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
        onPractice={verify}
        run={run}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {a.status === "open" && (
          <Button
            disabled={busy}
            onClick={() => run(a.id, () => api.updateAction(a.id, "in_progress").then(onChanged))}
          >
            Start
          </Button>
        )}
        <Button variant="secondary" disabled={busy} onClick={markDone}>
          {busy
            ? "Working…"
            : `Mark done${checked.size ? ` (${checked.size}/${a.successCriteria.length})` : ""}`}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={verify}>
          Verify with a question
        </Button>
      </div>
    </Card>
  );
}

export default function PrepPlan() {
  const [actions, setActions] = useState<PrepAction[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [canFetchResources, setCanFetchResources] = useState(false);

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
      <div className="space-y-5">
        <PageHeader title="Preparation plan" />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const open = (actions ?? [])
    .filter((a) => a.status === "open" || a.status === "in_progress")
    .sort((a, b) => a.priority - b.priority);
  const today = open.slice(0, 3);
  const upcoming = open.slice(3);
  const history = (actions ?? [])
    .filter((a) => a.status === "done" || a.status === "superseded")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Preparation plan"
        subtitle="An adaptive plan built from your gaps — finish an action, then verify it with a question."
        actions={
          <Button variant="secondary" onClick={recalc} disabled={busy === "recalc"}>
            {busy === "recalc" ? "Recalculating…" : "Recalculate"}
          </Button>
        }
      />
      <ErrorNote error={error} />

      {open.length === 0 && !error && (
        <Card>
          <EmptyState
            title="No open actions"
            description="Set a target role or recalculate the plan."
            action={
              <Link to="/target">
                <Button variant="secondary">Open target</Button>
              </Link>
            }
          />
        </Card>
      )}

      {today.length > 0 && (
        <div className="space-y-4">
          <SectionHeading
            title="Today"
            description="The actions that will move your readiness most."
          />
          {today.map((a) => (
            <ActionCard
              key={a.id}
              action={a}
              busy={busy === a.id}
              canFetchResources={canFetchResources}
              onChanged={load}
              run={run}
            />
          ))}
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="space-y-4">
          <SectionHeading
            title="Upcoming"
            description="Lower-priority actions for later."
          />
          {upcoming.map((a) => (
            <ActionCard
              key={a.id}
              action={a}
              busy={busy === a.id}
              canFetchResources={canFetchResources}
              onChanged={load}
              run={run}
            />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <Card>
          <button
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            className="flex w-full items-center justify-between text-left"
          >
            <CardTitle>History ({history.length})</CardTitle>
            <span aria-hidden className="text-muted">
              {showHistory ? "▾" : "▸"}
            </span>
          </button>
          {showHistory && (
            <ul className="space-y-2 text-sm">
              {history.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-2 border-t border-line pt-2"
                >
                  <span className="text-muted line-through">{a.action}</span>
                  <Pill tone={a.status === "done" ? "green" : "muted"}>
                    {ACTION_STATUS[a.status]}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        <SectionHeading
          title="Improve your application materials"
          description="ATS review, bullet rewrites, and role tailoring — grounded only in your resume."
          action={
            <Link to="/resume">
              <Button variant="secondary" size="small">
                Open resume coach
              </Button>
            </Link>
          }
        />
      </Card>

      <PluginSuggestions onAccepted={load} onError={(e) => setError(e)} />
      <PluginSlot slot="prepare.activities" />
    </div>
  );
}

/** v1: activities suggested by `preparation` plugins — "Add to plan" accepts. */
function PluginSuggestions({
  onAccepted,
  onError,
}: {
  onAccepted: () => void;
  onError: (e: unknown) => void;
}) {
  const [groups, setGroups] = useState<PluginSuggestionGroup[]>([]);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api.pluginPrepSuggestions().then((r) => setGroups(r.suggestions)).catch(() => {});
  }, []);
  const visible = groups.filter((g) => g.activities.length > 0);
  if (visible.length === 0) return null;
  return (
    <Card>
      <CardTitle>Suggestions from plugins</CardTitle>
      <div className="mt-2 space-y-3">
        {visible.map((g) => (
          <div key={g.pluginId}>
            <p className="text-xs font-medium text-muted">from plugin {g.pluginName}</p>
            <ul className="mt-1 space-y-2">
              {g.activities.map((a, i) => {
                const key = `${g.pluginId}:${i}`;
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-3 rounded-[0.6rem] bg-page p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-navy">{a.title}</p>
                      <p className="truncate text-xs text-muted">{a.action}</p>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={busy === key || added.has(key)}
                      onClick={() => {
                        setBusy(key);
                        api
                          .acceptPluginSuggestion(g.pluginId, a)
                          .then(() => {
                            setAdded((prev) => new Set(prev).add(key));
                            toast("Added to plan");
                            onAccepted();
                          })
                          .catch(onError)
                          .finally(() => setBusy(null));
                      }}
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
    </Card>
  );
}
