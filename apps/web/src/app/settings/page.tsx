"use client";

import { useEffect, useState } from "react";
import {
  api,
  type AppSettings,
  type RuntimeModel,
  type RuntimeStatus,
} from "@/lib/api";
import { Button, Card, CardTitle, ErrorNote, PageHeader, Pill, SkeletonCard, Spinner, toast } from "@/components/ui";

const EFFORTS = ["low", "medium", "high"] as const;

export default function Settings() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<RuntimeModel[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () => api.runtimeStatus().then(setStatus).catch((e) => setError(e));
  useEffect(() => {
    load();
    api.runtimeModels().then(setModels).catch(() => setModels([]));
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setDraft(s);
        setSaved(s);
      })
      .catch((e) => setError(e));
  }, []);

  const check = () => {
    setChecking(true);
    api.runtimeCheck().then(setStatus).catch((e) => setError(e)).finally(() => setChecking(false));
  };

  const selectedModel = models.find((m) => m.id === draft?.codexModel) ?? null;
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
        <CardTitle>AI Runtime — Local Codex</CardTitle>
        {status && (
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
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
                value={draft.codexModel ?? ""}
                onChange={(e) =>
                  setDraft((d) => d && { ...d, codexModel: e.target.value || null })
                }
                className="w-full rounded-[0.6rem] border border-line bg-surface px-3 py-2"
              >
                <option value="">Codex default</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Reasoning effort</span>
              <select
                value={draft.reasoningEffort ?? ""}
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
            </label>
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

      <Card>
        <CardTitle>Advanced</CardTitle>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Runtime mode</dt><dd>{status?.mode ?? "—"}</dd>
          <dt className="text-muted">Sandbox</dt><dd>read-only</dd>
          <dt className="text-muted">Approvals</dt>
          <dd>
            Codex runs in a read-only sandbox in data/codex-workspace; approval
            requests are declined automatically.
          </dd>
        </dl>
      </Card>
    </div>
  );
}
