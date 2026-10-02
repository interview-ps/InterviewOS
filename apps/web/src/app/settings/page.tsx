"use client";

import { useEffect, useState } from "react";
import { api, type RuntimeStatus } from "@/lib/api";
import { Button, Card, CardTitle, ErrorNote, Pill, Spinner } from "@/components/ui";

export default function Settings() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  const load = () => api.runtimeStatus().then(setStatus).catch((e) => setError(e));
  useEffect(() => { load(); }, []);

  const check = () => {
    setChecking(true);
    api.runtimeCheck().then(setStatus).catch((e) => setError(e)).finally(() => setChecking(false));
  };

  if (!status && !error) return <Spinner label="Loading settings…" />;

  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="text-xl font-bold text-navy">Settings</h1>
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
        <CardTitle>Advanced</CardTitle>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Runtime mode</dt><dd>{status?.mode ?? "—"}</dd>
          <dt className="text-muted">Sandbox</dt><dd>read-only</dd>
          <dt className="text-muted">Approvals</dt><dd>declined automatically</dd>
        </dl>
      </Card>
    </div>
  );
}
