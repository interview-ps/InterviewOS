import { useEffect, useState } from "react";
import { VOICE_DISCLAIMER } from "@interview-os/frontend-types";
import {
  api,
  type AppSettings,
  type McpServerInfo,
  type McpToolInfo,
  type PluginView,
  type RuntimeAvailability,
  type RuntimeModel,
  type RuntimeStatus,
} from "@/lib/api";
import { runtimeLabel } from "@/lib/runtime";
import { Button, Card, CardTitle, ErrorNote, PageHeader, Pill, SkeletonCard, Spinner, toast } from "@/components/ui";
import { PluginSlot } from "@/components/plugin-ui";
import { PluginSettingsForm } from "@/components/plugin-settings-form";

const EFFORTS = ["low", "medium", "high"] as const;

const EXPORT_PARTS = [
  "candidate",
  "targets",
  "readiness",
  "evidence",
  "interviews",
  "preparation",
] as const;

/** rough per-table preview counts from an export bundle. */
function bundleCounts(bundle: unknown): [string, number][] {
  if (!bundle || typeof bundle !== "object") return [];
  const b = bundle as Record<string, unknown>;
  const out: [string, number][] = [];
  const add = (key: string, v: unknown) => {
    if (Array.isArray(v)) out.push([key, v.length]);
  };
  const sections: [string, Record<string, unknown> | undefined][] = [
    ["candidate", b.candidate as Record<string, unknown>],
    ["targets", b.targets as Record<string, unknown>],
    ["readiness", b.readiness as Record<string, unknown>],
    ["evidence", b.evidence as Record<string, unknown>],
    ["interviews", b.interviews as Record<string, unknown>],
    ["preparation", b.preparation as Record<string, unknown>],
  ];
  for (const [section, obj] of sections) {
    if (!obj) continue;
    for (const [k, v] of Object.entries(obj)) add(`${section}.${k}`, v);
  }
  add("stories", b.stories);
  add("resumeReviews", b.resumeReviews);
  add("interviewPacks", b.interviewPacks);
  add("questionBank", b.questionBank);
  add("externalContexts", b.externalContexts);
  return out;
}

function McpServerRow({
  server,
  onChanged,
  onError,
}: {
  server: McpServerInfo;
  onChanged: (s: McpServerInfo) => void;
  onError: (e: unknown) => void;
}) {
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [allowed, setAllowed] = useState<Set<string>>(new Set(server.allowedTools));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (server.enabled) {
      api.mcpTools(server.id).then((r) => setTools(r.tools)).catch(() => setTools([]));
    } else {
      setTools(null);
    }
  }, [server.id, server.enabled]);

  const save = (patch: { enabled?: boolean; allowedTools?: string[] }) => {
    setBusy(true);
    api
      .updateMcpServer(server.id, patch)
      .then(onChanged)
      .catch(onError)
      .finally(() => setBusy(false));
  };

  return (
    <li className="rounded-[0.6rem] border border-line p-3" data-testid={`mcp-server-${server.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-navy">{server.name}</span>
        <Pill tone={server.enabled ? "green" : "muted"}>
          {server.enabled ? "enabled" : "disabled"}
        </Pill>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={busy}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="accent-accent"
            data-testid={`mcp-enable-${server.id}`}
          />
          Enabled
        </label>
      </div>
      {server.description && (
        <p className="mt-1 text-sm text-muted">{server.description}</p>
      )}
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
        <dt className="text-muted">Command</dt>
        <dd className="font-mono break-all">
          {server.command} {server.args.join(" ")}
        </dd>
        {server.envPassthrough.length > 0 && (
          <>
            <dt className="text-muted">Env passthrough</dt>
            <dd className="font-mono">{server.envPassthrough.join(", ")}</dd>
          </>
        )}
      </dl>
      {server.enabled && (
        <div className="mt-2 border-t border-line pt-2">
          <p className="text-xs font-medium text-navy">Allowed tools</p>
          {tools === null ? (
            <Spinner label="Listing tools…" />
          ) : tools.length === 0 ? (
            <p className="mt-1 text-xs text-muted">
              No tools reported (server unreachable?).
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {tools.map((t) => (
                <li key={t.name}>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={allowed.has(t.name)}
                      onChange={(e) =>
                        setAllowed((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(t.name);
                          else next.delete(t.name);
                          return next;
                        })
                      }
                      className="mt-1 accent-accent"
                    />
                    <span>
                      <span className="font-mono text-xs">{t.name}</span>
                      {t.description && (
                        <span className="ml-2 text-xs text-muted">{t.description}</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => save({ allowedTools: [...allowed] })}
              data-testid={`mcp-save-${server.id}`}
            >
              Save allowed tools
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function Settings() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<RuntimeModel[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [avail, setAvail] = useState<RuntimeAvailability | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [mcp, setMcp] = useState<{ servers: McpServerInfo[]; loadError: string | null } | null>(null);
  const [importBundle, setImportBundle] = useState<unknown>(null);
  const [importCounts, setImportCounts] = useState<[string, number][]>([]);
  const [confirmText, setConfirmText] = useState("");
  const [importResult, setImportResult] = useState<Record<string, number> | null>(null);
  const [importing, setImporting] = useState(false);

  const load = () => api.runtimeStatus().then(setStatus).catch((e) => setError(e));
  useEffect(() => {
    load();
    api.runtimeAvailable().then(setAvail).catch(() => setAvail(null));
    api.runtimeModels().then(setModels).catch(() => setModels([]));
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setDraft(s);
        setSaved(s);
      })
      .catch((e) => setError(e));
    api.plugins().then((r) => setPlugins(r.plugins)).catch(() => {});
    api.mcpServers().then(setMcp).catch(() => setMcp({ servers: [], loadError: null }));
  }, []);

  const check = () => {
    setChecking(true);
    api.runtimeCheck().then(setStatus).catch((e) => setError(e)).finally(() => setChecking(false));
    api.runtimeAvailable().then(setAvail).catch(() => {});
  };

  const switchRuntime = (kind: string) => {
    setSwitching(kind);
    setError(null);
    api
      .switchRuntime(kind)
      .then((s) => {
        setStatus(s);
        toast(`Switched to ${runtimeLabel(kind)}`);
        api.runtimeModels().then(setModels).catch(() => setModels([]));
        api.runtimeAvailable().then(setAvail).catch(() => {});
        api
          .settings()
          .then((s2) => {
            setSettings(s2);
            setDraft(s2);
            setSaved(s2);
          })
          .catch(() => {});
      })
      .catch((e) => setError(e))
      .finally(() => setSwitching(null));
  };

  const selectedModel = models.find((m) => m.id === draft?.model) ?? null;
  const effortOptions =
    selectedModel && selectedModel.supportedReasoningEfforts.length > 0
      ? selectedModel.supportedReasoningEfforts
      : [...EFFORTS];

  const save = () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    api
      .saveSettings(draft)
      .then((s) => {
        setSettings(s);
        setDraft(s);
        setSaved(s);
        toast("Settings saved");
      })
      .catch((e) => setError(e))
      .finally(() => setSaving(false));
  };

  const dirty = draft && saved && JSON.stringify(draft) !== JSON.stringify(saved);

  if (!status && !error) {
    return (
      <div className="space-y-5">
        <PageHeader title="Settings" />
        <SkeletonCard lines={5} />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="Settings" subtitle="Runtime connection and model preferences." />
      <ErrorNote error={error} />

      <Card>
        <CardTitle>AI Runtime — {status ? runtimeLabel(status.mode) : "…"}</CardTitle>
        {avail && avail.providers.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {avail.providers.map((p) => {
              const active = p.runtime === avail.active;
              return (
                <button
                  key={p.runtime}
                  type="button"
                  disabled={switching !== null || active}
                  onClick={() => switchRuntime(p.runtime)}
                  className={`flex w-full items-center justify-between rounded-[0.6rem] border px-3 py-2 text-left text-sm transition disabled:cursor-default ${
                    active
                      ? "border-accent bg-surface"
                      : "border-line bg-surface hover:border-accent disabled:opacity-60"
                  }`}
                >
                  <span className="font-medium">
                    {runtimeLabel(p.runtime)}
                    {p.trustedLocal && (
                      <span className="ml-2 text-xs text-muted">
                        trusted local provider
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    {switching === p.runtime && (
                      <span className="text-xs text-muted">switching…</span>
                    )}
                    {p.version && (
                      <span className="text-xs text-muted">{p.version}</span>
                    )}
                    <Pill tone={active ? "blue" : p.available ? "green" : "muted"}>
                      {active ? "active" : p.available ? "ready" : p.status}
                    </Pill>
                  </span>
                </button>
              );
            })}
            <p className="pt-1 text-xs text-muted">
              Applies immediately and persists across restarts. The
              INTERVIEW_OS_RUNTIME env var overrides the saved choice.
            </p>
          </div>
        )}
        {status && (
          <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Status</dt>
            <dd>
              <Pill tone={status.available ? "green" : "amber"}>{status.status}</Pill>
            </dd>
            {status.version && (<><dt className="text-muted">Version</dt><dd>{status.version}</dd></>)}
            {status.executable && (<><dt className="text-muted">Executable</dt><dd className="break-all font-mono text-xs">{status.executable}</dd></>)}
            {status.workspace && (<><dt className="text-muted">Workspace</dt><dd className="break-all font-mono text-xs">{status.workspace}</dd></>)}
            <dt className="text-muted">Mode</dt>
            <dd>{status.mode}</dd>
            {status.message && (<><dt className="text-muted">Message</dt><dd>{status.message}</dd></>)}
          </dl>
        )}
        <div className="mt-4">
          <Button variant="secondary" onClick={check} disabled={checking}>
            {checking ? "Checking…" : "Check Connection"}
          </Button>
        </div>
      </Card>

      <Card>
        <CardTitle>Model &amp; execution</CardTitle>
        <p className="mt-1 text-xs text-muted">
          Applied on the next AI call — no restart needed.
        </p>
        {draft ? (
          <div className="mt-3 space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block font-medium">Model</span>
              <select
                value={draft.model ?? ""}
                onChange={(e) =>
                  setDraft((d) => d && { ...d, model: e.target.value || null })
                }
                className="w-full rounded-[0.6rem] border border-line bg-surface px-3 py-2"
              >
                <option value="">Provider default</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.id}){m.isDefault ? " — default" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Reasoning effort</span>
              <select
                value={draft.reasoningEffort ?? ""}
                disabled={effortOptions.length === 0}
                onChange={(e) =>
                  setDraft(
                    (d) =>
                      d && {
                        ...d,
                        reasoningEffort: (e.target.value ||
                          null) as AppSettings["reasoningEffort"],
                      },
                  )
                }
                className="w-full rounded-[0.6rem] border border-line bg-surface px-3 py-2"
              >
                <option value="">Model default</option>
                {effortOptions.map((ef) => (
                  <option key={ef} value={ef}>
                    {ef}
                    {selectedModel?.defaultReasoningEffort === ef ? " (model default)" : ""}
                  </option>
                ))}
              </select>
              {effortOptions.length === 0 && (
                <span className="mt-1 block text-xs text-muted">
                  This provider does not expose reasoning-effort levels.
                </span>
              )}
            </label>
            {status?.mode === "codex" && (
              <label className="block">
                <span className="mb-1 block font-medium">Task mode</span>
                <select
                  value={draft.taskMode}
                  onChange={(e) =>
                    setDraft(
                      (d) => d && { ...d, taskMode: e.target.value as AppSettings["taskMode"] },
                    )
                  }
                  className="w-full rounded-[0.6rem] border border-line bg-surface px-3 py-2"
                >
                  <option value="app-server">app-server (recommended — warm process, streams text)</option>
                  <option value="exec">exec (spawns `codex exec` per task)</option>
                </select>
              </label>
            )}
            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {!dirty && saved && (
                <span className="text-xs text-muted" aria-live="polite">Saved.</span>
              )}
            </div>
          </div>
        ) : (
          <Spinner label="Loading settings…" />
        )}
      </Card>

      {draft && (
        <Card>
          <CardTitle>Question sources</CardTitle>
          <p className="mt-1 text-xs text-muted">
            Where interviewers may draw questions from, in addition to generated ones.
          </p>
          {(() => {
            const qs = draft.questionSources ?? {
              companyPacks: true,
              rolePacks: true,
              userBank: true,
              plugins: [],
            };
            const set = (patch: Partial<typeof qs>) =>
              setDraft((d) => d && { ...d, questionSources: { ...qs, ...patch } });
            const sourcePlugins = plugins.filter(
              (p) => p.enabled && (p.manifest.capabilities ?? []).includes("question_source"),
            );
            return (
              <div className="mt-3 space-y-2 text-sm">
                {(
                  [
                    ["companyPacks", "Company packs"],
                    ["rolePacks", "Role packs"],
                    ["userBank", "My question bank"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={qs[key]}
                      onChange={(e) => set({ [key]: e.target.checked })}
                      className="accent-accent"
                      data-testid={`qs-${key}`}
                    />
                    {label}
                  </label>
                ))}
                {sourcePlugins.length > 0 && (
                  <div className="pt-1">
                    <p className="text-xs font-medium text-muted">Question-source plugins</p>
                    {sourcePlugins.map((p) => (
                      <label key={p.manifest.id} className="mt-1 flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={qs.plugins.includes(p.manifest.id)}
                          onChange={(e) =>
                            set({
                              plugins: e.target.checked
                                ? [...qs.plugins, p.manifest.id]
                                : qs.plugins.filter((x) => x !== p.manifest.id),
                            })
                          }
                          className="accent-accent"
                          data-testid={`qs-plugin-${p.manifest.id}`}
                        />
                        {p.manifest.name ?? p.manifest.id}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          <div className="mt-3">
            <Button onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Update sources"}
            </Button>
          </div>
        </Card>
      )}

      {draft && (
        <Card>
          <CardTitle>Voice</CardTitle>
          <p className="mt-1 text-xs text-muted">
            Voice capture uses the browser's Web Speech API (Chrome / Edge).
            Delivery hints never change evaluation or readiness.
          </p>
          <div className="mt-3 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.voice?.enabled ?? false}
                onChange={(e) =>
                  setDraft(
                    (d) =>
                      d && {
                        ...d,
                        voice: {
                          enabled: e.target.checked,
                          speakQuestions: d.voice?.speakQuestions ?? true,
                        },
                      },
                  )
                }
                className="accent-accent"
                data-testid="voice-enabled"
              />
              Enable voice mode on session pages
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.voice?.speakQuestions ?? true}
                onChange={(e) =>
                  setDraft(
                    (d) =>
                      d && {
                        ...d,
                        voice: {
                          enabled: d.voice?.enabled ?? false,
                          speakQuestions: e.target.checked,
                        },
                      },
                  )
                }
                className="accent-accent"
                data-testid="voice-speak"
              />
              Read questions aloud
            </label>
            <p className="text-xs text-muted">{VOICE_DISCLAIMER}</p>
          </div>
          <div className="mt-3">
            <Button onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Update voice"}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <span id="mcp" />
        <CardTitle>MCP servers</CardTitle>
        <p className="mt-1 text-xs text-muted">
          Servers are defined in interview-os.mcp.json on this machine — the
          browser can only enable them and choose which tools are allowed.
        </p>
        {mcp === null ? (
          <Spinner label="Loading MCP servers…" />
        ) : (
          <>
            {mcp.loadError && (
              <p role="alert" className="mt-2 text-xs text-danger">
                Config load error: {mcp.loadError}
              </p>
            )}
            {mcp.servers.length === 0 && !mcp.loadError && (
              <p className="mt-2 text-sm text-muted">
                No MCP servers configured.
              </p>
            )}
            <ul className="mt-3 space-y-2">
              {mcp.servers.map((s) => (
                <McpServerRow
                  key={s.id}
                  server={s}
                  onChanged={(updated) =>
                    setMcp(
                      (m) =>
                        m && {
                          ...m,
                          servers: m.servers.map((x) =>
                            x.id === updated.id ? updated : x,
                          ),
                        },
                    )
                  }
                  onError={setError}
                />
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card>
        <span id="data" />
        <CardTitle>Data</CardTitle>
        <p className="mt-1 text-xs text-muted">
          Export your workspace, or replace it with a previously exported bundle.
        </p>
        <div className="mt-3 flex flex-wrap gap-2" data-testid="export-links">
          <a
            href={api.exportUrl()}
            className="inline-flex items-center rounded-[0.6rem] border border-line px-3 py-1.5 text-sm text-blue"
            data-testid="export-all"
          >
            Export everything
          </a>
          {EXPORT_PARTS.map((part) => (
            <a
              key={part}
              href={api.exportPartUrl(part)}
              className="inline-flex items-center rounded-[0.6rem] border border-line px-3 py-1.5 text-sm text-blue"
              data-testid={`export-${part}`}
            >
              {part}
            </a>
          ))}
        </div>
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm font-medium text-navy">Import</p>
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Import bundle file"
            data-testid="import-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              f.text()
                .then((t) => {
                  const parsed: unknown = JSON.parse(t);
                  setImportBundle(parsed);
                  setImportCounts(bundleCounts(parsed));
                  setImportResult(null);
                  setConfirmText("");
                })
                .catch((err) => setError(err));
              e.target.value = "";
            }}
            className="mt-1 text-xs text-muted"
          />
          {importBundle != null && (
            <div className="mt-2 rounded-[0.6rem] bg-page p-3 text-sm" data-testid="import-preview">
              <p className="font-medium text-ink">Bundle preview</p>
              {importCounts.length === 0 ? (
                <p className="mt-1 text-xs text-danger">
                  This doesn't look like an Interview OS export bundle.
                </p>
              ) : (
                <ul className="mt-1 grid grid-cols-2 gap-x-4 text-xs text-muted sm:grid-cols-3">
                  {importCounts.map(([k, n]) => (
                    <li key={k}>
                      {k}: {n}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-danger">
                Import replaces ALL current data. Type <code>replace</code> to confirm.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="replace"
                  aria-label="Type replace to confirm"
                  data-testid="import-confirm"
                  className="rounded-[0.6rem] border border-line px-3 py-1.5 text-sm"
                />
                <Button
                  variant="secondary"
                  disabled={importing || confirmText !== "replace" || importCounts.length === 0}
                  onClick={() => {
                    setImporting(true);
                    setError(null);
                    api
                      .importState(importBundle)
                      .then((r) => {
                        setImportResult(r.counts);
                        setImportBundle(null);
                        setConfirmText("");
                        toast("Import complete");
                        return api.settings();
                      })
                      .then((s) => {
                        setSettings(s);
                        setDraft(s);
                        setSaved(s);
                      })
                      .catch(setError)
                      .finally(() => setImporting(false));
                  }}
                  data-testid="import-run"
                >
                  {importing ? "Importing…" : "Import (replaces everything)"}
                </Button>
              </div>
            </div>
          )}
          {importResult && (
            <div className="mt-2 rounded-[0.6rem] bg-page p-3 text-sm" data-testid="import-result">
              <p className="font-medium text-green">Import complete</p>
              <ul className="mt-1 grid grid-cols-2 gap-x-4 text-xs text-muted sm:grid-cols-3">
                {Object.entries(importResult).map(([k, n]) => (
                  <li key={k}>
                    {k}: {n}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>Advanced</CardTitle>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Runtime mode</dt><dd>{status?.mode ?? "—"}</dd>
          <dt className="text-muted">Sandbox</dt><dd>read-only</dd>
          <dt className="text-muted">Approvals</dt>
          <dd>
            {runtimeLabel(status?.mode ?? "codex")} runs with an allowlisted
            environment in a read-only workspace; approval requests are declined
            automatically.
          </dd>
        </dl>
      </Card>
      <PluginSlot slot="settings.sections" />
      {plugins.some((p) => p.enabled) && (
        <Card>
          <CardTitle>Plugin settings</CardTitle>
          <div className="mt-2 space-y-4">
            {plugins
              .filter((p) => p.enabled)
              .map((p) => (
                <PluginSettingsForm
                  key={p.manifest.id}
                  pluginId={p.manifest.id}
                  pluginName={p.manifest.name ?? p.manifest.id}
                />
              ))}
          </div>
        </Card>
      )}
    </div>
  );
}
