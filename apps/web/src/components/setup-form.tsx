import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Steps, Upload } from "antd";
import { api, streamPost, type SetupResult } from "@/lib/api";
import { Button, CardTitle, ErrorNote, toast } from "@/components/ui";

const LEVELS = ["junior", "mid", "senior", "staff"];
const ACCEPT = ".pdf,.docx,.txt,.md";

export interface FileMeta {
  name: string;
  chars: number;
  warnings: string[];
}

export interface SetupValues {
  resumeText: string;
  jobDescription: string;
  company: string;
  role: string;
  level: string;
  companyNotes: string;
}

export function FileNote({
  meta,
  onClear,
}: {
  meta: FileMeta | undefined;
  onClear?: () => void;
}) {
  if (!meta) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
      <span>
        {meta.name} — {meta.chars.toLocaleString()} characters
      </span>
      {onClear && (
        <button type="button" onClick={onClear} className="text-blue underline">
          Remove
        </button>
      )}
      {meta.warnings.map((w, i) => (
        <span key={i} className="block w-full text-accent">
          ⚠ {w}
        </span>
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
              <span className="text-green" aria-hidden>
                ✓
              </span>
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
        file
          .text()
          .then((t) => {
            setText(t);
            setMeta({ name: file.name, chars: t.length, warnings: [] });
          })
          .catch(onError);
      }
    },
    [setText, setMeta, onError],
  );
}

/**
 * The resume + job-description setup form. `workspace` creates the candidate and
 * first target; `target` adds another target against the existing resume. Shared
 * by first-run onboarding and the Target page so the fields live in one place.
 */
export function SetupForm({
  mode,
  showSteps = false,
  title,
  onDone,
  initialValues,
}: {
  mode: "workspace" | "target";
  showSteps?: boolean;
  title?: ReactNode;
  onDone?: (result?: SetupResult) => void;
  /** Persisted values to prefill (Target → Sources). */
  initialValues?: Partial<SetupValues>;
}) {
  const [form, setForm] = useState<SetupValues>(() => ({
    resumeText: initialValues?.resumeText ?? "",
    jobDescription: initialValues?.jobDescription ?? "",
    company: initialValues?.company ?? "",
    role: initialValues?.role ?? "",
    level: initialValues?.level ?? (mode === "workspace" ? "senior" : "mid"),
    companyNotes: initialValues?.companyNotes ?? "",
  }));
  // Captured once so edits can be labelled as unsaved relative to what's stored.
  const baseline = useRef(
    JSON.stringify({
      resumeText: initialValues?.resumeText ?? "",
      jobDescription: initialValues?.jobDescription ?? "",
      company: initialValues?.company ?? "",
      role: initialValues?.role ?? "",
      level: initialValues?.level ?? (mode === "workspace" ? "senior" : "mid"),
      companyNotes: initialValues?.companyNotes ?? "",
    }),
  );
  const [meta, setMeta] = useState<{ resumeText?: FileMeta; jobDescription?: FileMeta }>({});
  const [examples, setExamples] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stages, setStages] = useState<string[]>([]);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (mode === "workspace") api.examples().then(setExamples).catch(() => {});
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [mode]);

  const loadExample = (name: string) => {
    api
      .example(name)
      .then((ex) => {
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
      })
      .catch((e) => setError(e));
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

  const canSubmit =
    !busy &&
    !!form.jobDescription &&
    !!form.company &&
    !!form.role &&
    (mode === "target" || !!form.resumeText);

  /** Whether the form differs from the persisted values it was prefilled with. */
  const dirty = JSON.stringify(form) !== baseline.current;

  const submit = () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setElapsed(0);
    setStages([]);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    const done = (r?: SetupResult) => {
      setBusy(false);
      if (timer.current) clearInterval(timer.current);
      onDone?.(r);
    };
    if (mode === "target") {
      streamPost<unknown>(
        "/api/targets",
        {
          jobDescription: form.jobDescription,
          company: form.company,
          role: form.role,
          level: form.level,
          companyNotes: form.companyNotes || undefined,
        },
        { onStage: (name) => setStages((s) => [...s, name]) },
      )
        .then(() => {
          toast("Target added");
          done();
        })
        .catch((e) => {
          setError(e);
          setBusy(false);
          if (timer.current) clearInterval(timer.current);
        });
      return;
    }
    streamPost<SetupResult>("/api/workspace/setup", form, {
      onStage: (name) => setStages((s) => [...s, name]),
    })
      .then((r) => {
        setResult(r);
        toast("Workspace saved");
        done(r);
      })
      .catch((e) => {
        setError(e);
        setBusy(false);
        if (timer.current) clearInterval(timer.current);
      });
  };

  const steps = [
    { title: "Add your resume" },
    { title: "Add the job description" },
    { title: "Confirm the target role" },
    { title: "Analyze" },
  ];
  const current = !form.resumeText
    ? 0
    : !form.jobDescription
      ? 1
      : !form.company || !form.role
        ? 2
        : result
          ? 4
          : 3;

  return (
    <div>
      {showSteps && (
        <Steps
          size="small"
          current={current}
          items={steps}
          style={{ marginBottom: 20 }}
        />
      )}
      {title && <CardTitle>{title}</CardTitle>}
      <ErrorNote error={error} />

      {mode === "workspace" && (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Resume</span>
            <textarea
              value={form.resumeText}
              onChange={(e) => setForm((f) => ({ ...f, resumeText: e.target.value }))}
              rows={10}
              className="w-full rounded-[var(--radius-sm)] border border-line bg-surface p-3 text-[13px] leading-relaxed"
            />
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Upload
                accept={ACCEPT}
                maxCount={1}
                showUploadList={false}
                disabled={busy}
                aria-label="Upload resume file"
                beforeUpload={(file) => {
                  loadResumeFile(file as File);
                  return false;
                }}
              >
                <Button variant="secondary" size="small">
                  Upload file
                </Button>
              </Upload>
              <span className="text-xs text-muted">or paste above</span>
            </div>
            <FileNote
              meta={meta.resumeText}
              onClear={() => {
                setForm((f) => ({ ...f, resumeText: "" }));
                setMeta((p) => ({ ...p, resumeText: undefined }));
              }}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Job description</span>
            <textarea
              value={form.jobDescription}
              onChange={(e) => setForm((f) => ({ ...f, jobDescription: e.target.value }))}
              rows={10}
              className="w-full rounded-[var(--radius-sm)] border border-line bg-surface p-3 text-[13px] leading-relaxed"
            />
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Upload
                accept={ACCEPT}
                maxCount={1}
                showUploadList={false}
                disabled={busy}
                aria-label="Upload job description"
                beforeUpload={(file) => {
                  loadJdFile(file as File);
                  return false;
                }}
              >
                <Button variant="secondary" size="small">
                  Upload file
                </Button>
              </Upload>
              <span className="text-xs text-muted">or paste above</span>
            </div>
            <FileNote
              meta={meta.jobDescription}
              onClear={() => {
                setForm((f) => ({ ...f, jobDescription: "" }));
                setMeta((p) => ({ ...p, jobDescription: undefined }));
              }}
            />
          </label>
        </div>
      )}

      {mode === "target" && (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block font-medium">Job description</span>
          <textarea
            value={form.jobDescription}
            onChange={(e) => setForm((f) => ({ ...f, jobDescription: e.target.value }))}
            rows={6}
            className="w-full rounded-[var(--radius-sm)] border border-line bg-surface p-3 text-[13px] leading-relaxed"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Upload
              accept={ACCEPT}
              maxCount={1}
              showUploadList={false}
              disabled={busy}
              beforeUpload={(file) => {
                loadJdFile(file as File);
                return false;
              }}
            >
              <Button variant="secondary" size="small">
                Upload file
              </Button>
            </Upload>
            <span className="text-xs text-muted">or paste above</span>
          </div>
          <FileNote
            meta={meta.jobDescription}
            onClear={() => {
              setForm((f) => ({ ...f, jobDescription: "" }));
              setMeta((p) => ({ ...p, jobDescription: undefined }));
            }}
          />
        </label>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium">Company</span>
          <input
            value={form.company}
            onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
            className="w-full rounded-[var(--radius-sm)] border border-line px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Role</span>
          <input
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            className="w-full rounded-[var(--radius-sm)] border border-line px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Level</span>
          <select
            aria-label="Level"
            value={form.level}
            onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))}
            className="w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-medium text-navy">
          Company notes{" "}
          <span className="font-normal text-muted">
            (values, interview style — optional)
          </span>
        </summary>
        <label className="mt-2 block">
          <span className="sr-only">Company notes</span>
          <textarea
            value={form.companyNotes}
            onChange={(e) => setForm((f) => ({ ...f, companyNotes: e.target.value }))}
            rows={3}
            className="w-full rounded-[var(--radius-sm)] border border-line bg-surface p-3 text-xs"
          />
        </label>
      </details>

      <div className="mt-4 rounded-[var(--radius-sm)] border border-line bg-page p-3">
        <p className="text-sm font-medium text-navy">
          {!canSubmit
            ? "Add the missing fields to continue"
            : dirty
              ? mode === "target"
                ? "Ready to add this target"
                : "Ready to analyze"
              : "Sources match your last analysis"}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {!canSubmit
            ? mode === "target"
              ? "A job description, company and role are required."
              : "A resume and job description are required."
            : dirty
              ? mode === "target"
                ? "Interview OS compares your saved resume with this role and updates your preparation plan."
                : "Running Analyze replaces your saved resume, job description and preparation plan."
              : "Edit a field to analyze again; your plan stays as it is until you do."}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {mode === "workspace" && examples.length > 0 && (
            <label className="text-sm text-muted">
              Load example:{" "}
              <select
                defaultValue=""
                onChange={(e) => e.target.value && loadExample(e.target.value)}
                className="rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1.5"
              >
                <option value="" disabled>
                  Select…
                </option>
                {examples.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button type="submit" onClick={submit} disabled={!canSubmit}>
            {mode === "target" ? "Add target" : "Analyze"}
          </Button>
          {busy && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-2 text-sm text-muted"
            >
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-blue"
                aria-hidden
              />
              Working… {elapsed}s elapsed
            </span>
          )}
        </div>
      </div>
      {busy && <StageList stages={stages} running={busy} />}
    </div>
  );
}
