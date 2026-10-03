"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type SkillInfo, type SkillsList } from "@/lib/api";
import {
  Button,
  Card,
  CardTitle,
  ErrorNote,
  PageHeader,
  Pill,
  SkeletonCard,
  Spinner,
} from "@/components/ui";

function permTone(p: string): "green" | "amber" | "blue" {
  if (p.endsWith(".read")) return "green";
  if (p === "runtime.invoke") return "blue";
  return "amber"; // writes
}

function PermissionChips({ skill }: { skill: SkillInfo }) {
  const perms = [...new Set(skill.permissions)].sort();
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

interface ChecklistOutput {
  title?: string;
  items?: { title?: string; detail?: string }[];
}

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
  return (
    <pre
      data-testid="plugin-output"
      className="mt-3 max-h-64 overflow-auto rounded-[0.6rem] bg-page p-3 text-xs text-muted"
    >
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}

function PluginRunner({ skill }: { skill: SkillInfo }) {
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<unknown>(undefined);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(() => {
    setBusy(true);
    setError(null);
    api
      .runPlugin(skill.id)
      .then((r) => setOutput(r.output))
      .catch((e) => setError(e))
      .finally(() => setBusy(false));
  }, [skill.id]);

  return (
    <div>
      <Button
        variant="secondary"
        onClick={run}
        disabled={busy}
        data-testid={`run-plugin-${skill.id}`}
      >
        {busy ? "Running…" : "Run"}
      </Button>
      {error != null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      {output !== undefined && <PluginOutput output={output} />}
    </div>
  );
}

export default function Skills() {
  const [data, setData] = useState<SkillsList | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.skills().then(setData).catch(setError);
  }, []);

  if (!data && !error) {
    return (
      <div className="space-y-5">
        <PageHeader title="Skills &amp; plugins" />
        <SkeletonCard lines={5} />
      </div>
    );
  }

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

      {data && (
        <Card className="p-0" data-testid="skills-table">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="px-5 py-3">Skill</th>
                <th className="px-3 py-3">Kind</th>
                <th className="px-3 py-3">Version</th>
                <th className="px-3 py-3">Permissions</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.skills.map((s) => (
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
                    <Pill tone={s.kind === "plugin" ? "blue" : "muted"}>
                      {s.kind}
                    </Pill>
                  </td>
                  <td className="px-3 py-3 text-muted">v{s.version}</td>
                  <td className="px-3 py-3">
                    <PermissionChips skill={s} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    {s.kind === "plugin" && <PluginRunner skill={s} />}
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
