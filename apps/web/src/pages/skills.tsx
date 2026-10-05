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
  Card,
  CardTitle,
  ErrorNote,
  PageHeader,
  Pill,
  SkeletonCard,
  Spinner,
  toast,
} from "@/components/ui";
import { refreshUIContributions } from "@/components/plugin-ui";
import { PluginSettingsForm } from "@/components/plugin-settings-form";

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
  resources?: {
    title?: string;
    url?: string;
    kind?: string;
    summary?: string;
  }[];
}

const isHttps = (u: unknown): u is string =>
  typeof u === "string" && u.startsWith("https://");

function PluginOutput({ output }: { output: unknown }) {
  const checklist = output as ChecklistOutput;
  if (checklist && Array.isArray(checklist.items)) {
    return (
      <div data-testid="plugin-checklist" className="mt-3 space-y-2">
        {checklist.title && (
          <p className="text-sm font-semibold text-navy">{checklist.title}</p>
        )}
        <ul className="space-y-1.5">
          {checklist.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span
                aria-hidden
                className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line text-[10px] text-muted"
              >
                ☐
              </span>
              <div>
                <span className="font-medium text-ink">
                  {item.title ?? `Item ${i + 1}`}
                </span>
                {item.detail && (
                  <span className="ml-2 text-muted">{item.detail}</span>
                )}
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
      <div data-testid="plugin-questions" className="mt-3 space-y-2">
        <p className="text-sm font-semibold text-navy">
          Proposed questions ({questions.length})
        </p>
        <ul className="space-y-2">
          {questions.map((q, i) => (
            <li key={i} className="rounded-[0.5rem] bg-page p-2 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                {q.skillId && <Pill tone="muted">{q.skillId}</Pill>}
                {q.difficulty && <Pill tone="blue">{q.difficulty}</Pill>}
              </span>
              <p className="mt-1">{q.text ?? `Question ${i + 1}`}</p>
              {q.expectedConcepts && q.expectedConcepts.length > 0 && (
                <p className="mt-0.5 text-xs text-muted">
                  expects: {q.expectedConcepts.join(", ")}
                </p>
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
      <div data-testid="plugin-resources" className="mt-3 space-y-2">
        <p className="text-sm font-semibold text-navy">
          Resources ({resources.length})
        </p>
        <ul className="space-y-1.5">
          {resources.map((r, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2 text-sm">
              {r.kind && <Pill tone="muted">{r.kind}</Pill>}
              {isHttps(r.url) ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue underline"
                >
                  {r.title ?? r.url}
                </a>
              ) : (
                <span className="font-medium text-ink">
                  {r.title ?? `Resource ${i + 1}`}
                </span>
              )}
              {r.summary && <span className="text-xs text-muted">{r.summary}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <pre
      data-testid="plugin-output"
      className="mt-3 max-h-64 overflow-auto rounded-[0.6rem] bg-page p-3 text-xs text-muted"
    >
      {JSON.stringify(output, null, 2)}
    </pre>
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
    <div data-testid={`perm-review-${plugin.manifest.id}`} className="mt-3 rounded-[0.6rem] border border-line bg-page p-3">
      <p className="text-sm font-semibold text-navy">
        Review permissions — {plugin.manifest.name ?? plugin.manifest.id}
      </p>
      <table className="mt-2 w-full text-left text-sm" data-testid="perm-table">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th className="py-1.5">Category</th>
            <th className="py-1.5">Requested access</th>
            <th className="py-1.5 text-right">Grant</th>
          </tr>
        </thead>
        <tbody>
          {plugin.permissions.map((row) => {
            const perms = (CATEGORY_PERMS[row.category] ?? []).filter((p) =>
              requested.has(p),
            );
            const denied = ISOLATION_DENIED.has(row.category);
            const isUI = row.access === "UI";
            const grantable = row.requested && !denied && !isUI;
            const isEvidence = row.category === "Evidence (write)";
            return (
              <tr
                key={row.category}
                className={`border-b border-line/50 last:border-0 ${
                  denied ? "text-muted opacity-70" : ""
                }`}
              >
                <td className="py-1.5">
                  {row.category}
                  {denied && (
                    <span className="ml-2 text-xs">— blocked by isolation</span>
                  )}
                  {isEvidence && (
                    <p className="mt-0.5 text-xs text-amber-700">
                      lets this plugin add evidence to your readiness graph
                    </p>
                  )}
                  {isUI && row.detail && (
                    <p className="mt-0.5 text-xs text-muted">{row.detail}</p>
                  )}
                  {isUI && (
                    <p className="mt-0.5 text-xs text-muted">
                      contributions are active while the plugin is enabled
                    </p>
                  )}
                </td>
                <td className="py-1.5">
                  {denied ? (
                    <Pill tone="red">DENIED</Pill>
                  ) : isUI ? (
                    <Pill tone="blue">UI</Pill>
                  ) : row.requested ? (
                    <Pill
                      tone={
                        row.access === "WRITE"
                          ? "amber"
                          : row.access === "INVOKE"
                            ? "blue"
                            : "green"
                      }
                    >
                      {row.access === "DENIED" ? "READ" : row.access}
                    </Pill>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  {grantable && (
                    <input
                      type="checkbox"
                      aria-label={`grant ${row.category}`}
                      checked={
                        perms.length > 0 && perms.every((p) => checked.has(p))
                      }
                      onChange={(e) => toggle(perms, e.target.checked)}
                      className="accent-accent"
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
        <p role="alert" className="mt-2 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button onClick={save} disabled={busy} data-testid="save-permissions">
          {busy ? "Saving…" : "Enable plugin"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PluginCard({
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
    <Card data-testid={`plugin-${m.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-navy">{m.name ?? m.id}</span>
        <span className="text-xs text-muted">{m.id} · v{m.version}</span>
        {m.author && <span className="text-xs text-muted">by {m.author}</span>}
        <Pill tone={plugin.source === "git" ? "blue" : "muted"}>{plugin.source}</Pill>
        <Pill tone={plugin.compatible ? "green" : "red"}>
          {plugin.compatible ? "compatible" : "incompatible"}
        </Pill>
        {!plugin.compatible && m.engines?.["interview-os"] && (
          <span className="text-xs text-danger">
            requires interview-os {m.engines["interview-os"]}
          </span>
        )}
        {plugin.enabled && <Pill tone="green">enabled</Pill>}
      </div>
      {m.description && <p className="mt-1 text-sm text-muted">{m.description}</p>}
      {(m.capabilities ?? []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {(m.capabilities ?? []).map((cap) => (
            <Pill key={cap} tone="blue">{cap}</Pill>
          ))}
        </div>
      )}
      {plugin.loadError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          Load error: {plugin.loadError}
        </p>
      )}
      {error != null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!plugin.enabled ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setReviewing((v) => !v)}
            data-testid={`enable-${m.id}`}
          >
            {reviewing ? "Hide permissions" : "Enable…"}
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setEnabled(false)}
          >
            Disable
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={busy || !plugin.enabled || !plugin.compatible}
          onClick={run}
          data-testid={`run-plugin-${m.id}`}
        >
          {busy ? "Working…" : "Run"}
        </Button>
        {plugin.source === "git" &&
          (confirmDelete ? (
            <span className="flex items-center gap-2">
              <Button variant="secondary" disabled={busy} onClick={uninstall}>
                Confirm uninstall
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Uninstall
            </Button>
          ))}
      </div>

      {plugin.enabled && (
        <div className="mt-3 border-t border-line pt-3">
          <PluginSettingsForm pluginId={m.id} pluginName={m.name ?? m.id} />
        </div>
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

      {result && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="text-xs text-muted">
            evidence — {result.evidenceWritten} written ·{" "}
            {result.evidenceIgnored} ignored
            {result.evidenceRejected ? ` · rejected: ${result.evidenceRejected}` : ""}
          </p>
          <PluginOutput output={result.output} />
        </div>
      )}
    </Card>
  );
}

export default function Skills() {
  const [data, setData] = useState<SkillsList | null>(null);
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);

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
      <div className="space-y-5">
        <PageHeader title="Skills &amp; plugins" />
        <SkeletonCard lines={5} />
      </div>
    );
  }

  const builtins = (data?.skills ?? []).filter((s: SkillInfo) => s.kind !== "plugin");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Skills &amp; plugins"
        subtitle="Plugins are local code you trust; they can only receive the data their manifest declares."
      />
      <ErrorNote error={error} />

      {data && data.pluginErrors.length > 0 && (
        <Card data-testid="plugin-errors">
          <CardTitle>Plugin load errors</CardTitle>
          <ul className="space-y-2 text-sm">
            {data.pluginErrors.map((e, i) => (
              <li key={i} className="rounded-[0.6rem] bg-[#fdeef2] p-3">
                <span className="font-medium text-danger">
                  {e.dir}
                  <span className="text-muted">/{e.file}</span>
                </span>
                <span className="ml-2 text-muted">{e.error}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardTitle>Installed plugins</CardTitle>
        <div className="mt-3 space-y-3">
          {plugins === null && <Spinner label="Loading plugins…" />}
          {plugins?.length === 0 && (
            <p className="text-sm text-muted">No plugins installed.</p>
          )}
          {plugins?.map((p) => (
            <PluginCard
              key={p.manifest.id}
              plugin={p}
              onChanged={(updated) => onPluginChanged(p.manifest.id, updated)}
            />
          ))}
        </div>
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm font-medium text-navy">Install from Git</p>
          <div className="mt-2 flex gap-2">
            <input
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              placeholder="https://… or a local path"
              aria-label="Plugin URL or path"
              data-testid="install-url"
              className="min-w-0 flex-1 rounded-[0.6rem] border border-line px-3 py-2 text-sm"
            />
            <Button
              variant="secondary"
              disabled={installing || !installUrl.trim()}
              onClick={install}
              data-testid="install-plugin"
            >
              {installing ? "Installing…" : "Install"}
            </Button>
          </div>
        </div>
      </Card>

      {data && (
        <Card className="p-0" data-testid="skills-table">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="px-5 py-3">Built-in skill</th>
                <th className="px-3 py-3">Kind</th>
                <th className="px-3 py-3">Version</th>
                <th className="px-3 py-3">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {builtins.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-line/60 align-top last:border-0"
                >
                  <td className="px-5 py-3">
                    <div className="font-medium text-ink">{s.id}</div>
                    <div className="max-w-md text-xs text-muted">
                      {s.description}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Pill tone="muted">{s.kind}</Pill>
                  </td>
                  <td className="px-3 py-3 text-muted">v{s.version}</td>
                  <td className="px-3 py-3">
                    <PermissionChips permissions={s.permissions} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
