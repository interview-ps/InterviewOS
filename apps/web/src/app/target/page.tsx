"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SetupResult } from "@/lib/api";
import { Bar, Button, Card, CardTitle, ErrorNote, Pill, Spinner, skillLabel } from "@/components/ui";

const LEVELS = ["junior", "mid", "senior", "staff"];

export default function TargetRole() {
  const [form, setForm] = useState({ resumeText: "", jobDescription: "", company: "", role: "", level: "senior" });
  const [examples, setExamples] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.examples().then(setExamples).catch(() => {});
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const loadExample = (name: string) => {
    api.example(name).then((ex) => {
      setForm((f) => ({
        ...f,
        resumeText: ex.resumeText,
        jobDescription: ex.jobDescription,
        company: ex.company,
        role: ex.role,
        level: ex.level,
      }));
    }).catch((e) => setError(e));
  };

  const loadFile = (file: File | undefined, key: "resumeText" | "jobDescription") => {
    if (!file) return;
    file.text().then((t) => setForm((f) => ({ ...f, [key]: t })));
  };

  const submit = () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setElapsed(0);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    api
      .setup(form)
      .then(setResult)
      .catch((e) => setError(e))
      .finally(() => {
        setBusy(false);
        if (timer.current) clearInterval(timer.current);
      });
  };

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold text-navy">Target Role</h1>
      <ErrorNote error={error} />

      <Card>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Resume</span>
            <textarea
              value={form.resumeText}
              onChange={(e) => setForm((f) => ({ ...f, resumeText: e.target.value }))}
              rows={10}
              className="w-full rounded-[0.6rem] border border-line bg-surface p-3 font-mono text-xs"
            />
            <input
              type="file"
              accept=".txt,.md"
              aria-label="Upload resume file"
              className="mt-1 text-xs text-muted"
              onChange={(e) => loadFile(e.target.files?.[0], "resumeText")}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Job description</span>
            <textarea
              value={form.jobDescription}
              onChange={(e) => setForm((f) => ({ ...f, jobDescription: e.target.value }))}
              rows={10}
              className="w-full rounded-[0.6rem] border border-line bg-surface p-3 font-mono text-xs"
            />
            <input
              type="file"
              accept=".txt,.md"
              aria-label="Upload job description file"
              className="mt-1 text-xs text-muted"
              onChange={(e) => loadFile(e.target.files?.[0], "jobDescription")}
            />
          </label>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Company</span>
            <input
              value={form.company}
              onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
              className="w-full rounded-[0.6rem] border border-line px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Role</span>
            <input
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              className="w-full rounded-[0.6rem] border border-line px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Level</span>
            <select
              value={form.level}
              onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))}
              className="w-full rounded-[0.6rem] border border-line bg-surface px-3 py-2"
            >
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {examples.length > 0 && (
            <label className="text-sm text-muted">
              Load example:{" "}
              <select
                defaultValue=""
                onChange={(e) => e.target.value && loadExample(e.target.value)}
                className="rounded-[0.6rem] border border-line bg-surface px-2 py-1.5"
              >
                <option value="" disabled>Select…</option>
                {examples.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          <Button onClick={submit} disabled={busy || !form.resumeText || !form.jobDescription}>
            Analyze
          </Button>
          {busy && (
            <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-muted">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-blue" aria-hidden />
              Analyzing with AI… {elapsed}s elapsed
            </span>
          )}
        </div>
      </Card>

      {result && (
        <div className="space-y-5" aria-live="polite">
          <Card>
            <CardTitle>Candidate — {result.candidate.name ?? "unknown"}</CardTitle>
            <ul className="space-y-2">
              {result.candidate.skills.map((s) => (
                <li key={s.skillId} className="rounded-[0.6rem] border border-line p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{skillLabel(s.skillId)}</span>
                    <span className="text-muted">level {Math.round(s.level * 100)}%</span>
                  </div>
                  <Bar value={s.level} />
                  {s.evidence && <p className="mt-1 text-xs text-muted">“{s.evidence}”</p>}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardTitle>Requirements</CardTitle>
            <ul className="space-y-1.5 text-sm">
              {[...result.target.requirements, ...result.target.preferredSkills].map((r) => (
                <li key={r.skillId} className="flex items-center justify-between gap-2">
                  <span>{r.label || skillLabel(r.skillId)}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted">{Math.round(r.importance * 100)}%</span>
                    <Pill tone={r.kind === "required" ? "blue" : "muted"}>{r.kind}</Pill>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardTitle>Identified gaps</CardTitle>
            <ul className="space-y-1.5 text-sm">
              {result.gaps.map((g) => (
                <li key={g.skillId} className="flex items-center justify-between gap-2">
                  <span>{g.label || skillLabel(g.skillId)}</span>
                  <Pill tone={g.severity === "high" ? "amber" : g.severity === "medium" ? "blue" : "muted"}>
                    {g.severity}
                  </Pill>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
