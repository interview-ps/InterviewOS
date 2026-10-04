import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamPost, type CompanyProfileInfo, type SetupResult, type TargetListItem } from "@/lib/api";
import { Bar, Button, Card, CardTitle, ErrorNote, PageHeader, Pill, skillLabel, toast } from "@/components/ui";

const LEVELS = ["junior", "mid", "senior", "staff"];
const ACCEPT = ".pdf,.docx,.txt,.md";

interface FileMeta {
  name: string;
  chars: number;
  warnings: string[];
}

function FileNote({ meta }: { meta: FileMeta | undefined }) {
  if (!meta) return null;
  return (
    <p className="mt-1 text-xs text-muted" aria-live="polite">
      {meta.name} — {meta.chars.toLocaleString()} characters
      {meta.warnings.map((w, i) => (
        <span key={i} className="block text-accent">⚠ {w}</span>
      ))}
    </p>
  );
}

/** Live stage list streamed over SSE: done stages get ✓, last one spins. */
function StageList({ stages, running }: { stages: string[]; running: boolean }) {
  if (stages.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm" aria-live="polite">
      {stages.map((s, i) => {
        const current = running && i === stages.length - 1;
        return (
          <li key={`${s}-${i}`} className="flex items-center gap-2">
            {current ? (
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-blue"
                aria-hidden
              />
            ) : (
              <span className="text-green" aria-hidden>✓</span>
            )}
            <span className={current ? "text-ink" : "text-muted"}>{s}</span>
          </li>
        );
      })}
    </ul>
  );
}

function useDocLoader(
  setText: (text: string) => void,
  setMeta: (meta: FileMeta) => void,
  onError: (e: unknown) => void,
) {
  return useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".pdf") || lower.endsWith(".docx")) {
        api
          .extractDocument(file)
          .then((r) => {
            setText(r.text);
            setMeta({ name: file.name, chars: r.text.length, warnings: r.warnings });
          })
          .catch(onError);
      } else {
        file.text().then((t) => {
          setText(t);
          setMeta({ name: file.name, chars: t.length, warnings: [] });
        }).catch(onError);
      }
    },
    [setText, setMeta, onError],
  );
}

export default function TargetRole() {
  const [form, setForm] = useState({ resumeText: "", jobDescription: "", company: "", role: "", level: "senior", companyNotes: "" });
  const [meta, setMeta] = useState<{ resumeText?: FileMeta; jobDescription?: FileMeta }>({});
  const [targets, setTargets] = useState<TargetListItem[]>([]);
  const [profiles, setProfiles] = useState<CompanyProfileInfo[]>([]);
  const [addForm, setAddForm] = useState({ jobDescription: "", company: "", role: "", level: "mid", companyNotes: "" });
  const [addMeta, setAddMeta] = useState<FileMeta | undefined>();
  const [addBusy, setAddBusy] = useState(false);
  const [examples, setExamples] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stages, setStages] = useState<string[]>([]);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasCandidate = targets.length > 0;

  const loadTargets = useCallback(() => {
    api.listTargets().then(setTargets).catch(() => setTargets([]));
  }, []);

  useEffect(() => {
    api.examples().then(setExamples).catch(() => {});
    api.companies().then(setProfiles).catch(() => setProfiles([]));
    loadTargets();
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [loadTargets]);

  const loadExample = (name: string) => {
    api.example(name).then((ex) => {
      setForm((f) => ({
        ...f,
        resumeText: ex.resumeText,
        jobDescription: ex.jobDescription,
        company: ex.company,
        role: ex.role,
        level: ex.level,
        companyNotes: ex.companyNotes ?? "",
      }));
      setMeta({});
    }).catch((e) => setError(e));
  };

  const loadResumeFile = useDocLoader(
    (t) => setForm((f) => ({ ...f, resumeText: t })),
    (m) => setMeta((p) => ({ ...p, resumeText: m })),
    setError,
  );
  const loadJdFile = useDocLoader(
    (t) => setForm((f) => ({ ...f, jobDescription: t })),
    (m) => setMeta((p) => ({ ...p, jobDescription: m })),
    setError,
  );
  const loadAddJdFile = useDocLoader(
    (t) => setAddForm((f) => ({ ...f, jobDescription: t })),
    setAddMeta,
    setError,
  );

  const submit = () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setElapsed(0);
    setStages([]);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    streamPost<SetupResult>("/api/workspace/setup", form, {
      onStage: (name) => setStages((s) => [...s, name]),
    })
      .then((r) => {
        setResult(r);
        loadTargets();
        toast("Workspace saved");
      })
      .catch((e) => setError(e))
      .finally(() => {
        setBusy(false);
        if (timer.current) clearInterval(timer.current);
      });
  };

  const submitAdd = () => {
    setAddBusy(true);
    setError(null);
    setElapsed(0);
    setStages([]);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    streamPost<{ target: unknown; actions: unknown[] }>("/api/targets", {
      jobDescription: addForm.jobDescription,
      company: addForm.company,
      role: addForm.role,
      level: addForm.level,
      companyNotes: addForm.companyNotes || undefined,
    }, {
      onStage: (name) => setStages((s) => [...s, name]),
    })
      .then(() => window.location.reload())
      .catch((e) => {
        setError(e);
        setAddBusy(false);
        if (timer.current) clearInterval(timer.current);
      });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Target Role"
        subtitle="The job description and resume that drive your readiness model."
      />
      <ErrorNote error={error} />

      {targets.length > 0 && (
        <Card>
          <CardTitle>Your targets</CardTitle>
          {(() => {
            const activeTarget = targets.find((t) => t.active);
            if (!activeTarget) return null;
            const info =
              profiles.find((p) => p.id === activeTarget.companyProfileId) ??
              profiles.find((p) => p.id === "generic") ??
              null;
            const profile = activeTarget.companyProfile;
            return (
              <div className="mb-3 rounded-[0.6rem] border border-line bg-page p-3 text-sm" data-testid="company-profile">
                <label className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-navy">Company profile</span>
                  <select
                    aria-label="Company profile"
                    value={info?.id ?? "generic"}
                    onChange={(e) =>
                      api
                        .updateTargetProfile(activeTarget.id, e.target.value)
                        .then(() => window.location.reload())
                        .catch(setError)
                    }
                    className="rounded-[0.6rem] border border-line bg-surface px-2 py-1 text-sm"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                {info && (
                  <div className="mt-2 text-xs text-muted">
                    <p>
                      Typical loop: {info.typicalLoop.map((s) => s.label).join(" → ")}
                      {" · "}follow-up depth {info.followUpDepth}
                    </p>
                    {info.behavioralFramework && (
                      <p className="mt-0.5">
                        {info.behavioralFramework.name}:{" "}
                        {info.behavioralFramework.themes.join(", ")}
                      </p>
                    )}
                    <p className="mt-1 italic">{info.disclaimer}</p>
                  </div>
                )}
                {profile && profile.values.length > 0 && (
                  <p className="mt-1 text-muted">
                    <span className="text-ink">Values:</span> {profile.values.join(" · ")}
                  </p>
                )}
                {profile?.interviewStyle && (
                  <p className="mt-1 text-muted">
                    <span className="text-ink">Interview style:</span> {profile.interviewStyle}
                  </p>
                )}
                {profile && profile.focusSkillIds.length > 0 && (
                  <p className="mt-1 text-muted">
                    <span className="text-ink">Focus areas:</span>{" "}
                    {profile.focusSkillIds.map((id) => skillLabel(id)).join(", ")}
                  </p>
                )}
                {profile && profile.behavioralThemes.length > 0 && (
                  <p className="mt-1 text-muted">
                    <span className="text-ink">Behavioral themes:</span>{" "}
                    {profile.behavioralThemes.join(", ")}
                  </p>
                )}
              </div>
            );
          })()}
          <ul className="space-y-1.5 text-sm">
            {targets.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2">
                <span>
                  {t.role} — {t.company} <span className="text-xs text-muted">({t.level})</span>
                </span>
                {t.active ? (
                  <Pill tone="green">active</Pill>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      api.activateTarget(t.id).then(() => window.location.reload()).catch(setError)
                    }
                  >
                    Switch
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {hasCandidate && (
        <Card id="add-target">
          <CardTitle>Add another target role</CardTitle>
          <p className="mt-1 text-xs text-muted">
            Uses your current resume. The new target becomes active.
          </p>
          <label className="mt-3 block text-sm">
            <span className="mb-1 block font-medium">Job description</span>
            <textarea
              value={addForm.jobDescription}
              onChange={(e) => setAddForm((f) => ({ ...f, jobDescription: e.target.value }))}
              rows={6}
              className="w-full rounded-[0.6rem] border border-line bg-surface p-3 font-mono text-xs"
            />
            <input
              type="file"
              accept={ACCEPT}
              aria-label="Upload job description file"
              className="mt-1 text-xs text-muted"
              onChange={(e) => loadAddJdFile(e.target.files?.[0])}
            />
            <FileNote meta={addMeta} />
          </label>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Company</span>
              <input
                value={addForm.company}
                onChange={(e) => setAddForm((f) => ({ ...f, company: e.target.value }))}
                className="w-full rounded-[0.6rem] border border-line px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Role</span>
              <input
                value={addForm.role}
                onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value }))}
                className="w-full rounded-[0.6rem] border border-line px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Level</span>
              <select
                value={addForm.level}
                onChange={(e) => setAddForm((f) => ({ ...f, level: e.target.value }))}
                className="w-full rounded-[0.6rem] border border-line bg-surface px-3 py-2"
              >
                {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          </div>
          <label className="mt-3 block text-sm">
            <span className="mb-1 block font-medium">Company notes <span className="font-normal text-muted">(optional)</span></span>
            <textarea
              value={addForm.companyNotes}
              onChange={(e) => setAddForm((f) => ({ ...f, companyNotes: e.target.value }))}
              rows={2}
              className="w-full rounded-[0.6rem] border border-line bg-surface p-3 text-xs"
            />
          </label>
          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="secondary"
              onClick={submitAdd}
              disabled={addBusy || !addForm.jobDescription || !addForm.company || !addForm.role}
            >
              Add target
            </Button>
            {addBusy && (
              <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-muted">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-blue" aria-hidden />
                Working… {elapsed}s elapsed
              </span>
            )}
          </div>
          {addBusy && <StageList stages={stages} running={addBusy} />}
        </Card>
      )}

      <Card>
        <CardTitle>{hasCandidate ? "Start over with a new resume" : "Set up your workspace"}</CardTitle>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
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
              accept={ACCEPT}
              aria-label="Upload resume file"
              className="mt-1 text-xs text-muted"
              onChange={(e) => loadResumeFile(e.target.files?.[0])}
            />
            <FileNote meta={meta.resumeText} />
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
              accept={ACCEPT}
              aria-label="Upload job description file"
              className="mt-1 text-xs text-muted"
              onChange={(e) => loadJdFile(e.target.files?.[0])}
            />
            <FileNote meta={meta.jobDescription} />
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

        <label className="mt-3 block text-sm">
          <span className="mb-1 block font-medium">
            Company notes <span className="font-normal text-muted">(values, interview style — paste from the careers page)</span>
          </span>
          <textarea
            value={form.companyNotes}
            onChange={(e) => setForm((f) => ({ ...f, companyNotes: e.target.value }))}
            rows={3}
            className="w-full rounded-[0.6rem] border border-line bg-surface p-3 text-xs"
          />
        </label>

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
              Working… {elapsed}s elapsed
            </span>
          )}
        </div>
        {busy && <StageList stages={stages} running={busy} />}
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
                    {r.boostedBy === "company-profile" && <Pill tone="green">company profile</Pill>}
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
