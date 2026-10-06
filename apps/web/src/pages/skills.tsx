import { useCallback, useEffect, useState } from "react";
import {
  api,
  type PluginRunResult,
  type PluginView,
  type SkillInfo,
  type SkillsList,
} from "@/lib/api";
import {
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  Pill,
  ScreenToolbar,
  Skeleton,
  Spinner,
  Workspace,
  toast,
} from "@/components/ui";
import { refreshUIContributions } from "@/components/plugin-ui";
import { PluginSettingsForm } from "@/components/plugin-settings-form";

type TabKey = "installed" | "advanced";

function permTone(p: string): "green" | "amber" | "blue" {
  if (p.endsWith(".read")) return "green";
  if (p === "runtime.invoke") return "blue";
  return "amber"; // writes
}

function PermissionChips({ permissions }: { permissions: string[] }) {
  const perms = [...new Set(permissions)].sort();
  if (perms.length === 0) return <span className="text-xs text-muted">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {perms.map((p) => (
        <Pill key={p} tone={permTone(p)}>
          {p}
        </Pill>
      ))}
    </span>
  );
}

const ISOLATION_DENIED = new Set([
  "Local Files",
  "Network",
  "Environment/Secrets",
  "Commands",
]);

/** category label (from the server's permission view) → permission ids. */
const CATEGORY_PERMS: Record<string, string[]> = {
  "Candidate Profile": ["candidate.read"],
  Resume: ["resume.read"],
  Target: ["target.read"],
  Readiness: ["readiness.read", "taxonomy.read"],
  "Interview History": ["interview.read"],
  "STAR Stories": ["stories.read"],
  "Evidence (write)": ["evidence.write"],
  "AI Runtime": ["runtime.invoke"],
};

/** Default grants on enable: everything requested except evidence.write. */
function defaultGrants(p: PluginView): Set<string> {
  return new Set(p.manifest.permissions.filter((x) => x !== "evidence.write"));
}

interface ChecklistOutput {
  title?: string;
  items?: { title?: string; detail?: string }[];
}
interface QuestionsOutput {
  questions?: {
    skillId?: string;
    text?: string;
    difficulty?: string;
    expectedConcepts?: string[];
  }[];
}
interface ResourcesOutput {
  resources?: { title?: string; url?: string; kind?: string; summary?: string }[];
}

const isHttps = (u: unknown): u is string =>
  typeof u === "string" && u.startsWith("https://");

function PluginOutput({ output }: { output: unknown }) {
  const checklist = output as ChecklistOutput;
  if (checklist && Array.isArray(checklist.items)) {
    return (
      <div data-testid="plugin-checklist" className="mt-2 space-y-1.5">
        {checklist.title && <p className="text-[13px] font-semibold text-navy">{checklist.title}</p>}
        <ul className="space-y-1">
          {checklist.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <span
                aria-hidden
                className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line text-[10px] text-muted"
              >
                ☐
              </span>
              <div>
                <span className="font-medium text-ink">{item.title ?? `Item ${i + 1}`}</span>
                {item.detail && <span className="ml-2 text-muted">{item.detail}</span>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const questions = (output as QuestionsOutput)?.questions;
  if (Array.isArray(questions)) {
    return (
      <div data-testid="plugin-questions" className="mt-2 space-y-1.5">
        <p className="text-[13px] font-semibold text-navy">Proposed questions ({questions.length})</p>
        <ul className="space-y-1.5">
          {questions.map((q, i) => (
            <li key={i} className="rounded-[var(--radius-sm)] bg-page p-2 text-[13px]">
              <span className="flex flex-wrap items-center gap-2">
                {q.skillId && <Pill tone="muted">{q.skillId}</Pill>}
                {q.difficulty && <Pill tone="blue">{q.difficulty}</Pill>}
              </span>
              <p className="mt-1">{q.text ?? `Question ${i + 1}`}</p>
              {q.expectedConcepts && q.expectedConcepts.length > 0 && (
                <p className="mt-0.5 text-xs text-muted">expects: {q.expectedConcepts.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const resources = (output as ResourcesOutput)?.resources;
  if (Array.isArray(resources)) {
    return (
      <div data-testid="plugin-resources" className="mt-2 space-y-1.5">
        <p className="text-[13px] font-semibold text-navy">Resources ({resources.length})</p>
        <ul className="space-y-1.5">
          {resources.map((r, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2 text-[13px]">
              {r.kind && <Pill tone="muted">{r.kind}</Pill>}
              {isHttps(r.url) ? (
                <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-blue underline">
                  {r.title ?? r.url}
                </a>
              ) : (
                <span className="font-medium text-ink">{r.title ?? `Resource ${i + 1}`}</span>
              )}
              {r.summary && <span className="text-xs text-muted">{r.summary}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-muted">View raw output</summary>
      <pre
        data-testid="plugin-output"
        className="mt-1.5 max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-page p-2.5 text-xs text-muted"
      >
        {JSON.stringify(output, null, 2)}
      </pre>
    </details>
  );
}

function PermissionReview({
  plugin,
  onSaved,
  onCancel,
}: {
  plugin: PluginView;
  onSaved: (p: PluginView) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => defaultGrants(plugin));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requested = new Set(plugin.manifest.permissions);

  const toggle = (perms: string[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const p of perms) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });

  const save = () => {
    setBusy(true);
    setError(null);
    api
      .setPluginEnabled(plugin.manifest.id, true, [...checked])
      .then((r) => {
        refreshUIContributions();
        onSaved(r.plugin);
        toast(`${plugin.manifest.name ?? plugin.manifest.id} enabled`);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <div
      data-testid={`perm-review-${plugin.manifest.id}`}
      className="mx-3 mb-2 rounded-[var(--radius-sm)] border border-line bg-page p-2.5"
    >
      <p className="text-[13px] font-semibold text-navy">
        Review permissions — {plugin.manifest.name ?? plugin.manifest.id}
      </p>
      <table className="mt-1.5 w-full text-left text-[13px]" data-testid="perm-table">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th className="py-1">Category</th>
            <th className="py-1">Requested access</th>
            <th className="py-1 text-right">Grant</th>
          </tr>
        </thead>
        <tbody>
          {plugin.permissions.map((row) => {
            const perms = (CATEGORY_PERMS[row.category] ?? []).filter((p) => requested.has(p));
            const denied = ISOLATION_DENIED.has(row.category);
            const isUI = row.access === "UI";
            const grantable = row.requested && !denied && !isUI;
            const isEvidence = row.category === "Evidence (write)";
            return (
              <tr
                key={row.category}
                className={`border-b border-line/50 last:border-0 ${denied ? "text-muted opacity-70" : ""}`}
              >
                <td className="py-1">
                  {row.category}
                  {denied && <span className="ml-2 text-xs">— blocked by isolation</span>}
                  {isEvidence && (
                    <p className="mt-0.5 text-xs text-accent">
                      lets this plugin add evidence to your readiness graph
                    </p>
                  )}
                  {isUI && (
                    <p className="mt-0.5 text-xs text-muted">
                      {row.detail} contributions are active while the plugin is enabled
                    </p>
                  )}
                </td>
                <td className="py-1">
                  {denied ? (
                    <Pill tone="red">DENIED</Pill>
                  ) : isUI ? (
                    <Pill tone="blue">UI</Pill>
                  ) : row.requested ? (
                    <Pill
                      tone={
                        row.access === "WRITE" ? "amber" : row.access === "INVOKE" ? "blue" : "green"
                      }
                    >
                      {row.access === "DENIED" ? "READ" : row.access}
                    </Pill>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </td>
                <td className="py-1 text-right">
                  {grantable && (
                    <input
                      type="checkbox"
                      aria-label={`grant ${row.category}`}
                      checked={perms.length > 0 && perms.every((p) => checked.has(p))}
                      onChange={(e) => toggle(perms, e.target.checked)}
                      className="accent-blue"
                      {...(isEvidence ? { "data-testid": "grant-evidence-write" } : {})}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error != null && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <Button size="small" onClick={save} disabled={busy} data-testid="save-permissions">
          {busy ? "Saving…" : "Enable plugin"}
        </Button>
        <Button variant="secondary" size="small" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PluginRow({
  plugin,
  onChanged,
}: {
  plugin: PluginView;
  onChanged: (p: PluginView | null) => void;
}) {
  const m = plugin.manifest;
  const [reviewing, setReviewing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<PluginRunResult | null>(null);

  const setEnabled = (enabled: boolean) => {
    setBusy(true);
    setError(null);
    api
      .setPluginEnabled(m.id, enabled)
      .then((r) => {
        refreshUIContributions();
        onChanged(r.plugin);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };

  const run = () => {
    setBusy(true);
    setError(null);
    api
      .runPlugin(m.id)
      .then(setResult)
      .catch(setError)
      .finally(() => setBusy(false));
  };

  const uninstall = () => {
    setBusy(true);
    setError(null);
    api
      .uninstallPlugin(m.id)
      .then(() => {
        refreshUIContributions();
        onChanged(null);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <section
      data-testid={`plugin-${m.id}`}
      className="rounded-[var(--radius-card)] border border-line bg-surface"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
        <span className="text-[13px] font-semibold text-navy">{m.name ?? m.id}</span>
        <span className="text-xs text-muted">
          {m.id} · v{m.version}
          {m.author ? ` · by ${m.author}` : ""}
        </span>
        <Pill tone={plugin.source === "git" ? "blue" : "muted"}>{plugin.source}</Pill>
        <Pill tone={plugin.compatible ? "green" : "red"}>
          {plugin.compatible ? "compatible" : "incompatible"}
        </Pill>
        {plugin.enabled && <Pill tone="green">enabled</Pill>}
        {!plugin.compatible && m.engines?.["interview-os"] && (
          <span className="text-xs text-danger">requires interview-os {m.engines["interview-os"]}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!plugin.enabled ? (
            <Button
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={() => setReviewing((v) => !v)}
              data-testid={`enable-${m.id}`}
            >
              {reviewing ? "Hide permissions" : "Review & enable"}
            </Button>
          ) : (
            <Button variant="secondary" size="small" disabled={busy} onClick={() => setEnabled(false)}>
              Disable
            </Button>
          )}
          <Button
            variant="secondary"
            size="small"
            disabled={busy || !plugin.enabled || !plugin.compatible}
            onClick={run}
            data-testid={`run-plugin-${m.id}`}
          >
            {busy ? "Working…" : "Try it"}
          </Button>
          {plugin.source === "git" &&
            (confirmDelete ? (
              <span className="flex items-center gap-2">
                <Button variant="secondary" size="small" disabled={busy} onClick={uninstall}>
                  Confirm uninstall
                </Button>
                <Button variant="ghost" size="small" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button variant="ghost" size="small" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Uninstall
              </Button>
            ))}
        </div>
      </div>

      {m.description && <p className="px-3 pb-1.5 text-xs text-muted">{m.description}</p>}
      {(m.capabilities ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-1.5">
          {(m.capabilities ?? []).map((cap) => (
            <Pill key={cap} tone="blue">{cap}</Pill>
          ))}
        </div>
      )}
      {plugin.loadError && (
        <p role="alert" className="px-3 pb-1.5 text-xs text-danger">Load error: {plugin.loadError}</p>
      )}
      {error != null && (
        <p role="alert" className="px-3 pb-1.5 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {reviewing && !plugin.enabled && (
        <PermissionReview
          plugin={plugin}
          onSaved={(p) => {
            setReviewing(false);
            onChanged(p);
          }}
          onCancel={() => setReviewing(false)}
        />
      )}

      {plugin.enabled && (
        <details className="mx-3 mb-2 border-t border-line pt-1.5">
          <summary className="cursor-pointer text-xs text-muted">Configuration</summary>
          <div className="mt-1.5">
            <PluginSettingsForm pluginId={m.id} pluginName={m.name ?? m.id} />
          </div>
        </details>
      )}

      {result && (
        <div className="mx-3 mb-2 border-t border-line pt-1.5">
          <p className="text-xs text-muted">
            evidence — {result.evidenceWritten} written · {result.evidenceIgnored} ignored
            {result.evidenceRejected ? ` · rejected: ${result.evidenceRejected}` : ""}
          </p>
          <PluginOutput output={result.output} />
        </div>
      )}
    </section>
  );
}

export default function Skills() {
  const [data, setData] = useState<SkillsList | null>(null);
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<TabKey>("installed");

  const load = useCallback(() => {
    api.skills().then(setData).catch(setError);
    api.plugins().then((r) => setPlugins(r.plugins)).catch(setError);
  }, []);
  useEffect(load, [load]);

  const onPluginChanged = (id: string, updated: PluginView | null) =>
    setPlugins((ps) =>
      updated
        ? (ps ?? []).map((p) => (p.manifest.id === id ? updated : p))
        : (ps ?? []).filter((p) => p.manifest.id !== id),
    );

  const install = () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    setError(null);
    api
      .installPlugin(installUrl.trim())
      .then((r) => {
        setInstallUrl("");
        setPlugins((ps) => [...(ps ?? []), r.plugin]);
        toast("Plugin installed — review its permissions to enable it");
      })
      .catch(setError)
      .finally(() => setInstalling(false));
  };

  if (!data && !error) {
    return (
      <Workspace toolbar={<ScreenToolbar title="Extensions" />} bodyClassName="space-y-3">
        <Skeleton className="h-40 w-full" />
      </Workspace>
    );
  }

  const builtins = (data?.skills ?? []).filter((s: SkillInfo) => s.kind !== "plugin");
  const visible = (plugins ?? []).filter((p) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    const m = p.manifest;
    return (
      m.id.toLowerCase().includes(q) ||
      (m.name ?? "").toLowerCase().includes(q) ||
      (m.description ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <Workspace
      toolbar={
        <ScreenToolbar
          title="Extensions"
          subtitle="Interview modes, integrations and the built-in skills Interview OS ships with."
          tabs={
            <div className="flex items-center gap-1">
              {(
                [
                  ["installed", "Installed"],
                  ["advanced", "Advanced"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-current={tab === key ? "page" : undefined}
                  onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 px-2.5 py-1.5 text-[13px] ${
                    tab === key
                      ? "border-blue font-semibold text-navy"
                      : "border-transparent text-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
          actions={
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search extensions…"
              aria-label="Search extensions"
              className="w-48 rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1 text-[13px]"
            />
          }
        />
      }
    >
      <ErrorNote error={error} />

      {tab === "installed" && (
        <div className="space-y-2">
          <details className="text-xs text-muted">
            <summary className="cursor-pointer text-blue">How extensions stay safe</summary>
            <p className="mt-1 max-w-prose">
              Extensions run in-process and can only <em>propose</em> evidence — nothing reaches your
              readiness graph without the permission you grant. Review what each one asks for before
              enabling it.
            </p>
          </details>

          {data && data.pluginErrors.length > 0 && (
            <Panel title="Plugin load errors" data-testid="plugin-errors">
              <ul className="space-y-1.5 text-[13px]">
                {data.pluginErrors.map((e, i) => (
                  <li key={i} className="rounded-[var(--radius-sm)] bg-[var(--color-danger-tint)] p-2">
                    <span className="font-medium text-danger">
                      {e.dir}
                      <span className="text-muted">/{e.file}</span>
                    </span>
                    <span className="ml-2 text-muted">{e.error}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {plugins === null && <Spinner label="Loading plugins…" />}
          {plugins?.length === 0 && (
            <Panel>
              <EmptyState
                title="No extensions installed"
                description="Install one from Git below, or enable a bundled extension."
              />
            </Panel>
          )}
          {visible.map((p) => (
            <PluginRow
              key={p.manifest.id}
              plugin={p}
              onChanged={(updated) => onPluginChanged(p.manifest.id, updated)}
            />
          ))}
          {plugins && plugins.length > 0 && visible.length === 0 && (
            <p className="text-sm text-muted">No extensions match “{query}”.</p>
          )}

          <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-3 py-2">
            <span className="text-[13px] font-medium text-navy">Install from Git</span>
            <input
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              placeholder="https://… or a local path"
              aria-label="Plugin URL or path"
              data-testid="install-url"
              className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-line px-2 py-1 text-[13px]"
            />
            <Button
              variant="secondary"
              size="small"
              disabled={installing || !installUrl.trim()}
              onClick={install}
              data-testid="install-plugin"
            >
              {installing ? "Installing…" : "Install"}
            </Button>
          </div>
        </div>
      )}

      {tab === "advanced" && data && (
        <Panel title="Built-in skills" padded={false} data-testid="skills-table">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2">Built-in skill</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Version</th>
                <th className="px-3 py-2">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {builtins.map((s) => (
                <tr key={s.id} className="border-b border-line/60 align-top last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{s.id}</div>
                    <div className="max-w-md text-xs text-muted">{s.description}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Pill tone="muted">{s.kind}</Pill>
                  </td>
                  <td className="px-3 py-2 text-muted">v{s.version}</td>
                  <td className="px-3 py-2">
                    <PermissionChips permissions={s.permissions} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </Workspace>
  );
}
