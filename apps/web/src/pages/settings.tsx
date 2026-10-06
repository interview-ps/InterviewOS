import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { VOICE_DISCLAIMER } from "@interview-os/frontend-types";
import { Menu, Radio, Select } from "antd";
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
import {
  Button,
  CollapseList,
  DataRow,
  ErrorNote,
  Pill,
  ScreenToolbar,
  SettingRow,
  SkeletonCard,
  Spinner,
  toast,
  Workspace,
} from "@/components/ui";
import { ExtensionSlot } from "@/components/plugin-ui";
import { PluginSettingsForm } from "@/components/plugin-settings-form";
import { useDesktop } from "@/lib/responsive";

const EFFORTS = ["low", "medium", "high"] as const;

const EXPORT_PARTS = [
  "candidate",
  "targets",
  "readiness",
  "evidence",
  "interviews",
  "preparation",
] as const;

const CATEGORIES = [
  { key: "ai", label: "AI and model" },
  { key: "interview", label: "Interview preferences" },
  { key: "sources", label: "Question sources" },
  { key: "voice", label: "Voice" },
  { key: "integrations", label: "Integrations" },
  { key: "data", label: "Data" },
  { key: "extensions", label: "Extension settings" },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]["key"];

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
    <li className="border-b border-line py-2 last:border-b-0" data-testid={`mcp-server-${server.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-navy">{server.name}</span>
        <Pill tone={server.enabled ? "green" : "muted"}>
          {server.enabled ? "enabled" : "disabled"}
        </Pill>
        <label className="ml-auto flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={busy}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="accent-blue"
            data-testid={`mcp-enable-${server.id}`}
          />
          Enabled
        </label>
      </div>
      {server.description && <p className="mt-1 text-xs text-muted">{server.description}</p>}
      <dl className="mt-1 grid grid-cols-[8rem_1fr] gap-y-0.5 text-xs">
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
        <div className="mt-1.5 border-t border-line pt-1.5">
          <p className="text-xs font-medium text-navy">Allowed tools</p>
          {tools === null ? (
            <Spinner label="Listing tools…" />
          ) : tools.length === 0 ? (
            <p className="mt-1 text-xs text-muted">No tools reported (server unreachable?).</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {tools.map((t) => (
                <li key={t.name}>
                  <label className="flex items-start gap-2 text-[13px]">
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
                      className="mt-1 accent-blue"
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
          <div className="mt-1.5">
            <Button
              variant="secondary"
              size="small"
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

/** Small section heading used inside the settings content area. */
function GroupHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-1 text-sm font-semibold text-navy">{children}</h2>
  );
}

export default function Settings() {
  const location = useLocation();
  const desktop = useDesktop();
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
  const [section, setSection] = useState<CategoryKey>(
    location.hash === "#data" ? "data" : "ai",
  );

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

  // Deep links (#diagnostics, #data, #mcp) select the matching category.
  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (hash === "data") setSection("data");
    else if (hash === "mcp") setSection("integrations");
    else if (hash === "diagnostics") setSection("ai");
  }, [location.hash]);

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

  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));

  if (!status && !error) {
    return (
      <Workspace toolbar={<ScreenToolbar title="Settings" />} bodyClassName="space-y-3">
        <SkeletonCard lines={6} />
      </Workspace>
    );
  }

  const qs = draft?.questionSources ?? {
    companyPacks: true,
    rolePacks: true,
    userBank: true,
    plugins: [],
  };
  const setQs = (patch: Partial<typeof qs>) =>
    setDraft((d) => d && { ...d, questionSources: { ...qs, ...patch } });
  const sourcePlugins = plugins.filter(
    (p) => p.enabled && (p.manifest.capabilities ?? []).includes("question_source"),
  );

  return (
    <Workspace
      scroll={false}
      toolbar={
        <ScreenToolbar
          title="Settings"
          subtitle="AI runtime, preferences, integrations and your data."
          actions={
            <>
              {dirty && <span className="text-xs text-accent">Unsaved settings</span>}
              <Button size="small" onClick={save} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {!dirty && saved && (
                <span className="text-xs text-muted" aria-live="polite">
                  Settings saved.
                </span>
              )}
            </>
          }
        />
      }
    >
      <ErrorNote error={error} />

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-4">
        {desktop ? (
          <nav className="w-44 shrink-0 overflow-auto" aria-label="Settings categories">
            <Menu
              mode="inline"
              selectedKeys={[section]}
              onClick={(e) => setSection(e.key as CategoryKey)}
              items={CATEGORIES.map((c) => ({ key: c.key, label: c.label }))}
              style={{ borderInlineEnd: "none" }}
            />
          </nav>
        ) : (
          <Select
            aria-label="Settings category"
            value={section}
            onChange={(v) => setSection(v as CategoryKey)}
            style={{ width: "100%" }}
            options={CATEGORIES.map((c) => ({ value: c.key, label: c.label }))}
          />
        )}

        <div className="min-w-0 max-w-3xl flex-1 overflow-auto pb-2">
          {section === "ai" && (
            <div className="space-y-5">
              <section>
                <GroupHeading>AI runtime</GroupHeading>
                <SettingRow
                  label={`Runtime — ${status ? runtimeLabel(status.mode) : "…"}`}
                  description="Switching applies immediately and persists across restarts. Runtime overrides are under Advanced diagnostics."
                  control={
                    <>
                      <Pill tone={status?.available ? "green" : "amber"}>
                        {status?.available ? "connected" : "not available"}
                      </Pill>
                      <Button variant="secondary" size="small" onClick={check} disabled={checking}>
                        {checking ? "Checking…" : "Check connection"}
                      </Button>
                    </>
                  }
                />
                {avail && avail.providers.length > 0 && (
                  <>
                    <ul className="mt-1 rounded-[var(--radius-card)] border border-line bg-surface">
                      {avail.providers.map((p) => {
                        const active = p.runtime === avail.active;
                        return (
                          <li key={p.runtime}>
                            <DataRow
                              selected={active}
                              leading={
                                <Radio
                                  name="runtime-provider"
                                  checked={active}
                                  disabled={switching !== null}
                                  aria-label={`Use ${runtimeLabel(p.runtime)}`}
                                  onChange={() => {
                                    if (!active) switchRuntime(p.runtime);
                                  }}
                                />
                              }
                              title={
                                <>
                                  {runtimeLabel(p.runtime)}
                                  {p.trustedLocal && (
                                    <span className="ml-2 text-xs text-muted">trusted local</span>
                                  )}
                                </>
                              }
                              meta={
                                <>
                                  {p.version}
                                  {switching === p.runtime ? " · switching…" : ""}
                                </>
                              }
                              trailing={
                                <Pill tone={active ? (p.available ? "green" : "amber") : "muted"}>
                                  {active
                                    ? p.available
                                      ? "in use · connected"
                                      : "in use · unavailable"
                                    : p.available
                                      ? "ready to use"
                                      : p.status}
                                </Pill>
                              }
                            />
                          </li>
                        );
                      })}
                    </ul>
                    <p className="mt-1 text-xs text-muted">
                      <strong>In use</strong> is the selected provider. <strong>Connected</strong>{" "}
                      means it is reachable now; <strong>ready to use</strong> means it is installed
                      and can be selected.
                    </p>
                  </>
                )}
              </section>

              <section>
                <GroupHeading>Model &amp; execution</GroupHeading>
                <p className="mb-1 text-xs text-muted">
                  Applies after Save to new AI calls — no restart needed.
                </p>
                {draft ? (
                  <>
                    <SettingRow
                      label="Model"
                      description="Provider default unless overridden."
                      control={
                        <select
                          aria-label="Model"
                          value={draft.model ?? ""}
                          onChange={(e) => setDraft((d) => d && { ...d, model: e.target.value || null })}
                          className="w-full rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1 text-[13px] sm:w-auto sm:min-w-56"
                        >
                          <option value="">Provider default</option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.displayName} ({m.id}){m.isDefault ? " — default" : ""}
                            </option>
                          ))}
                        </select>
                      }
                    />
                    <SettingRow
                      label="Reasoning effort"
                      description={
                        effortOptions.length === 0
                          ? "This provider does not expose reasoning-effort levels."
                          : undefined
                      }
                      control={
                        <select
                          aria-label="Reasoning effort"
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
                          className="w-full rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1 text-[13px] sm:w-auto sm:min-w-40"
                        >
                          <option value="">Model default</option>
                          {effortOptions.map((ef) => (
                            <option key={ef} value={ef}>
                              {ef}
                              {selectedModel?.defaultReasoningEffort === ef ? " (model default)" : ""}
                            </option>
                          ))}
                        </select>
                      }
                    />
                  </>
                ) : (
                  <Spinner label="Loading settings…" />
                )}
              </section>

              {status && (
                <section id="diagnostics">
                  <CollapseList
                    items={[
                      {
                        key: "diagnostics",
                        label: "Advanced diagnostics",
                        children: (
                          <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-[13px]">
                            <dt className="text-muted">Status</dt>
                            <dd>
                              <Pill tone={status.available ? "green" : "amber"}>{status.status}</Pill>
                            </dd>
                            {status.version && (
                              <>
                                <dt className="text-muted">Version</dt>
                                <dd>{status.version}</dd>
                              </>
                            )}
                            {status.executable && (
                              <>
                                <dt className="text-muted">Executable</dt>
                                <dd className="break-all font-mono text-xs">{status.executable}</dd>
                              </>
                            )}
                            {status.workspace && (
                              <>
                                <dt className="text-muted">Workspace</dt>
                                <dd className="break-all font-mono text-xs">{status.workspace}</dd>
                              </>
                            )}
                            <dt className="text-muted">Mode</dt>
                            <dd>{status.mode}</dd>
                            {status.message && (
                              <>
                                <dt className="text-muted">Message</dt>
                                <dd>{status.message}</dd>
                              </>
                            )}
                            <dt className="text-muted">Sandbox</dt>
                            <dd>read-only workspace</dd>
                            <dt className="text-muted">Approvals</dt>
                            <dd className="text-muted">
                              Runs with an allowlisted environment; approval requests are declined
                              automatically.
                            </dd>
                            <dt className="text-muted">Override</dt>
                            <dd className="text-muted">
                              If the <code>INTERVIEW_OS_RUNTIME</code> environment variable is set it
                              overrides the saved choice, including this switch.
                            </dd>
                          </dl>
                        ),
                      },
                    ]}
                  />
                </section>
              )}
            </div>
          )}

          {section === "interview" && (
            <section>
              <GroupHeading>Interview preferences</GroupHeading>
              {draft && status?.mode === "codex" ? (
                <SettingRow
                  label="Task execution mode"
                  description="Codex only — how one-shot AI tasks run."
                  control={
                    <select
                      aria-label="Task mode"
                      value={draft.taskMode}
                      onChange={(e) =>
                        setDraft((d) => d && { ...d, taskMode: e.target.value as AppSettings["taskMode"] })
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1 text-[13px] sm:w-auto sm:min-w-64"
                    >
                      <option value="app-server">app-server (warm process, streams text)</option>
                      <option value="exec">exec (spawns `codex exec` per task)</option>
                    </select>
                  }
                />
              ) : (
                <SettingRow
                  label="Task execution mode"
                  description="Applies to the Codex runtime only; the active runtime does not use it."
                  control={<Pill tone="muted">{status ? runtimeLabel(status.mode) : "…"}</Pill>}
                />
              )}
              <SettingRow
                label="Question sources"
                description="Which sources interviewers may draw questions from."
                control={
                  <span className="text-xs text-muted">
                    {[qs.companyPacks && "company packs", qs.rolePacks && "role packs", qs.userBank && "question bank"]
                      .filter(Boolean)
                      .join(", ") || "generated only"}
                  </span>
                }
              />
            </section>
          )}

          {section === "sources" && draft && (
            <section>
              <GroupHeading>Question sources</GroupHeading>
              <p className="mb-1 text-xs text-muted">
                Where interviewers may draw questions from, in addition to generated ones.
              </p>
              {(
                [
                  ["companyPacks", "Company packs"],
                  ["rolePacks", "Role packs"],
                  ["userBank", "My question bank"],
                ] as const
              ).map(([key, label]) => (
                <SettingRow
                  key={key}
                  label={label}
                  control={
                    <input
                      type="checkbox"
                      checked={qs[key]}
                      onChange={(e) => setQs({ [key]: e.target.checked })}
                      className="accent-blue"
                      data-testid={`qs-${key}`}
                    />
                  }
                />
              ))}
              {sourcePlugins.map((p) => (
                <SettingRow
                  key={p.manifest.id}
                  label={p.manifest.name ?? p.manifest.id}
                  description="Question-source plugin"
                  control={
                    <input
                      type="checkbox"
                      checked={qs.plugins.includes(p.manifest.id)}
                      onChange={(e) =>
                        setQs({
                          plugins: e.target.checked
                            ? [...qs.plugins, p.manifest.id]
                            : qs.plugins.filter((x) => x !== p.manifest.id),
                        })
                      }
                      className="accent-blue"
                      data-testid={`qs-plugin-${p.manifest.id}`}
                    />
                  }
                />
              ))}
            </section>
          )}

          {section === "voice" && draft && (
            <section>
              <GroupHeading>Voice</GroupHeading>
              <p className="mb-1 max-w-prose text-xs text-muted">
                Voice capture uses the browser's Web Speech API (Chrome / Edge). Delivery hints never
                change evaluation or readiness. {VOICE_DISCLAIMER}
              </p>
              <SettingRow
                label="Enable voice mode on session pages"
                control={
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
                    className="accent-blue"
                    data-testid="voice-enabled"
                  />
                }
              />
              <SettingRow
                label="Read questions aloud"
                control={
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
                    className="accent-blue"
                    data-testid="voice-speak"
                  />
                }
              />
            </section>
          )}

          {section === "integrations" && (
            <section id="mcp">
              <GroupHeading>MCP servers</GroupHeading>
              <p className="mb-1 max-w-prose text-xs text-muted">
                Servers are defined in interview-os.mcp.json on this machine — the browser can only
                enable them and choose which tools are allowed.
              </p>
              {mcp === null ? (
                <Spinner label="Loading MCP servers…" />
              ) : (
                <>
                  {mcp.loadError && (
                    <p role="alert" className="mt-1 text-xs text-danger">
                      Config load error: {mcp.loadError}
                    </p>
                  )}
                  {mcp.servers.length === 0 && !mcp.loadError ? (
                    <SettingRow
                      label="No MCP servers configured"
                      description="Add them to interview-os.mcp.json to enable external context."
                      control={<span className="text-xs text-muted">disabled by default</span>}
                    />
                  ) : (
                    <ul className="rounded-[var(--radius-card)] border border-line bg-surface px-3">
                      {mcp.servers.map((s) => (
                        <McpServerRow
                          key={s.id}
                          server={s}
                          onChanged={(updated) =>
                            setMcp(
                              (m) =>
                                m && {
                                  ...m,
                                  servers: m.servers.map((x) => (x.id === updated.id ? updated : x)),
                                },
                            )
                          }
                          onError={setError}
                        />
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>
          )}

          {section === "data" && (
            <section id="data" className="space-y-4">
              <div>
                <GroupHeading>Export</GroupHeading>
                <SettingRow
                  label="Export workspace"
                  description="A dated bundle of all your data, or a single part."
                  control={
                    <>
                      <a
                        href={api.exportUrl()}
                        data-testid="export-all"
                        className="inline-flex items-center rounded-[var(--radius-sm)] border border-line px-2.5 py-1 text-[13px] text-blue"
                      >
                        Export everything
                      </a>
                      <details className="relative">
                        <summary className="cursor-pointer list-none rounded-[var(--radius-sm)] border border-line px-2.5 py-1 text-[13px] text-blue">
                          Parts
                        </summary>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {EXPORT_PARTS.map((part) => (
                            <a
                              key={part}
                              href={api.exportPartUrl(part)}
                              data-testid={`export-${part}`}
                              className="inline-flex items-center rounded-[var(--radius-sm)] border border-line px-2 py-0.5 text-xs text-blue"
                            >
                              {part}
                            </a>
                          ))}
                        </div>
                      </details>
                    </>
                  }
                />
              </div>

              <div>
                <GroupHeading>Import</GroupHeading>
                <p className="mb-1 text-xs text-muted">
                  Import replaces ALL current data with the bundle's contents.
                </p>
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
                  className="text-xs text-muted"
                />
                {importBundle != null && (
                  <div className="mt-2 rounded-[var(--radius-card)] border border-line bg-page p-3 text-[13px]" data-testid="import-preview">
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
                        className="rounded-[var(--radius-sm)] border border-line px-2 py-1 text-[13px]"
                      />
                      <Button
                        variant="danger"
                        size="small"
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
                  <div className="mt-2 rounded-[var(--radius-card)] border border-line bg-page p-3 text-[13px]" data-testid="import-result">
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
            </section>
          )}

          {section === "extensions" && (
            <section>
              <GroupHeading>Extension settings</GroupHeading>
              {plugins.some((p) => p.enabled) ? (
                <div className="space-y-4">
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
              ) : (
                <SettingRow
                  label="No extensions enabled"
                  description="Enable extensions under Extensions to configure them here."
                  control={<span className="text-xs text-muted">none enabled</span>}
                />
              )}
              <div className="mt-3">
                <ExtensionSlot slot="settings.sections" />
              </div>
            </section>
          )}
        </div>
      </div>
    </Workspace>
  );
}
