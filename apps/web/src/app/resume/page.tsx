"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type AtsCheck,
  type ResumeReview,
} from "@/lib/api";
import {
  Bar,
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorNote,
  PageHeader,
  Pill,
  SkeletonCard,
  Spinner,
  skillLabel,
  toast,
} from "@/components/ui";

const STATUS_ICON = { pass: "✓", warn: "!", fail: "✗" } as const;
const STATUS_CLS = {
  pass: "bg-green-tint text-green",
  warn: "bg-[#fdf3e7] text-accent",
  fail: "bg-[#fdeef2] text-danger",
} as const;

function CheckRow({ check }: { check: AtsCheck }) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <span
        aria-label={check.status}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${STATUS_CLS[check.status]}`}
      >
        {STATUS_ICON[check.status]}
      </span>
      <div>
        <div className="font-medium text-ink">{check.label}</div>
        <div className="text-xs text-muted">{check.detail}</div>
      </div>
    </li>
  );
}

/** Highlight [placeholders] in improved bullets. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="rounded bg-[#fdf3e7] px-0.5 text-accent">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function Resume() {
  const [review, setReview] = useState<ResumeReview | null>(null);
  const [hasResume, setHasResume] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    api
      .state()
      .then(() => setHasResume(true))
      .catch((e) => {
        setHasResume(!(e instanceof ApiError) || e.status !== 404);
        if (!(e instanceof ApiError && e.status === 404)) setError(e);
      });
    api
      .latestResumeReview()
      .then((r) => setReview(r))
      .catch(() => setReview(null));
  }, []);

  const runReview = useCallback(() => {
    setBusy(true);
    setStage(null);
    setError(null);
    api
      .reviewResume({
        onStage: (name) => setStage(name),
      })
      .then((r) => setReview(r))
      .catch((e) => setError(e))
      .finally(() => {
        setBusy(false);
        setStage(null);
      });
  }, []);

  const copy = useCallback((idx: number, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(idx);
      toast("Copied to clipboard");
      setTimeout(() => setCopied((c) => (c === idx ? null : c)), 1500);
    });
  }, []);

  if (hasResume === null && !error) {
    return (
      <div className="space-y-5">
        <PageHeader title="Resume coach" />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Resume coach"
        subtitle="ATS check, bullet rewrites and tailoring — grounded only in your resume."
      />
      <p
        data-testid="resume-banner"
        className="rounded-[0.6rem] border border-line bg-tint p-3 text-sm text-muted"
      >
        Interview OS never invents facts — placeholders like{" "}
        <code className="text-accent">[add metric]</code> are for you to fill in
        truthfully.
      </p>
      <ErrorNote error={error} />

      {hasResume === false && (
        <Card>
          <EmptyState
            title="No resume on file"
            description="Set up your workspace on the Target page first — the coach reviews the resume you upload there."
            action={
              <a href="/target">
                <Button variant="secondary">Open target</Button>
              </a>
            }
          />
        </Card>
      )}

      {hasResume !== false && (
        <div className="flex items-center gap-3">
          <Button onClick={runReview} disabled={busy} data-testid="run-review">
            {review ? "Run review again" : "Run review"}
          </Button>
          {busy && <Spinner label={`${stage ?? "starting"}…`} />}
          {review && (
            <span className="text-xs text-muted">
              Last reviewed {new Date(review.createdAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {review && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card data-testid="ats-card">
            <CardTitle>ATS check</CardTitle>
            <div className="mb-4 flex items-center gap-4">
              <div
                data-testid="ats-score"
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-4 border-blue text-xl font-bold text-navy"
              >
                {review.ats.score}
              </div>
              <div className="flex-1">
                <Bar
                  value={review.ats.score / 100}
                  tone={
                    review.ats.score >= 70
                      ? "green"
                      : review.ats.score >= 45
                        ? "blue"
                        : "amber"
                  }
                />
                <p className="mt-1 text-xs text-muted">
                  Weighted pass ratio — deterministic, no AI involved.
                </p>
              </div>
            </div>
            <ul className="space-y-3">
              {review.ats.checks.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </ul>
          </Card>

          <Card>
            <CardTitle>Required-skill keywords</CardTitle>
            {review.ats.keywordCoverage.present.length === 0 &&
            review.ats.keywordCoverage.missing.length === 0 ? (
              <p className="text-sm text-muted">
                The target role lists no required skills.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {review.ats.keywordCoverage.present.map((k) => (
                  <li key={k.skillId} className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-tint text-xs font-bold text-green">
                      ✓
                    </span>
                    <div>
                      <span className="font-medium text-ink">{k.label}</span>
                      <span className="ml-2 text-xs text-muted">
                        found: “{k.snippet.slice(0, 90)}”
                      </span>
                    </div>
                  </li>
                ))}
                {review.ats.keywordCoverage.missing.map((k) => (
                  <li
                    key={k.skillId}
                    data-missing-skill={k.skillId}
                    className="flex items-start gap-2"
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#fdf3e7] text-xs font-bold text-accent">
                      !
                    </span>
                    <div className="text-sm">
                      <span className="font-medium text-ink">{k.label}</span>
                      <span className="ml-2 text-xs text-muted">
                        Not in your resume — if you have this experience, add
                        it; otherwise see{" "}
                        <a className="text-blue underline" href="/prepare">
                          Prepare
                        </a>
                        .
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="xl:col-span-2" data-testid="suggestions-card">
            <CardTitle>
              Bullet suggestions{" "}
              {review.guard.substitutions + review.guard.dropped > 0 && (
                <span className="ml-2 text-xs font-normal text-muted">
                  guard: {review.guard.substitutions} metric
                  {review.guard.substitutions === 1 ? "" : "s"} substituted
                  {review.guard.dropped > 0 &&
                    ` · ${review.guard.dropped} suggestion${review.guard.dropped === 1 ? "" : "s"} dropped (invented entity)`}
                </span>
              )}
            </CardTitle>
            {review.suggestions.length === 0 ? (
              <p className="text-sm text-muted">
                No weak bullets found — nice.
              </p>
            ) : (
              <ul className="space-y-4">
                {review.suggestions.map((s, i) => (
                  <li
                    key={i}
                    className="rounded-[0.6rem] border border-line p-4"
                    data-testid="suggestion"
                  >
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                          Original
                        </div>
                        <p className="text-sm text-muted line-through decoration-muted/50">
                          {s.original}
                        </p>
                      </div>
                      <div>
                        <div className="mb-1 flex items-center gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-green">
                            Suggested
                          </span>
                          <Button
                            variant="ghost"
                            onClick={() => copy(i, s.improved)}
                          >
                            {copied === i ? "Copied!" : "Copy"}
                          </Button>
                        </div>
                        <p className="text-sm text-ink">
                          <Highlighted text={s.improved} />
                        </p>
                      </div>
                    </div>
                    {s.dropped && (
                      <p className="mt-2 rounded-[0.4rem] bg-[#fdeef2] px-2 py-1 text-xs text-danger">
                        Guard dropped an invented fact: {s.dropped}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {s.skillIds.map((id) => (
                        <Pill key={id} tone="blue">
                          {skillLabel(id)}
                        </Pill>
                      ))}
                      {s.rationale && (
                        <span className="text-xs text-muted">
                          {s.rationale}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {review.tailoring && (
            <Card className="xl:col-span-2" data-testid="tailoring-card">
              <CardTitle>Tailored to this role</CardTitle>
              <p className="mb-4 text-sm text-ink">
                {review.tailoring.summary}
              </p>
              <div className="mb-4 grid gap-4 md:grid-cols-2">
                {review.tailoring.emphasize.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-sm font-semibold text-navy">
                      Emphasize
                    </h3>
                    <ul className="list-inside list-disc space-y-1 text-sm text-muted">
                      {review.tailoring.emphasize.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {review.tailoring.deEmphasize.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-sm font-semibold text-navy">
                      De-emphasize
                    </h3>
                    <ul className="list-inside list-disc space-y-1 text-sm text-muted">
                      {review.tailoring.deEmphasize.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {review.tailoring.alignment.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                        <th className="py-2 pr-4">Requirement</th>
                        <th className="py-2 pr-4">In your resume?</th>
                        <th className="py-2">Suggestion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.tailoring.alignment.map((a, i) => (
                        <tr key={i} className="border-b border-line/60">
                          <td className="py-2 pr-4 align-top font-medium text-ink">
                            {a.requirement}
                          </td>
                          <td className="py-2 pr-4 align-top text-muted">
                            {a.resumeEvidence ? (
                              <span title={a.resumeEvidence}>✓ yes</span>
                            ) : (
                              "— not yet"
                            )}
                          </td>
                          <td className="py-2 align-top text-muted">
                            <Highlighted text={a.suggestion} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {review.tailoring.prepGaps.length > 0 && (
                <p className="mt-3 text-sm text-muted">
                  Gaps for preparation, not the resume:{" "}
                  {review.linkedGapSkillIds.length > 0
                    ? review.linkedGapSkillIds
                        .map((id) => skillLabel(id))
                        .join(", ")
                    : review.tailoring.prepGaps.join(", ")}
                  {" — see "}
                  <a className="text-blue underline" href="/prepare">
                    Prepare
                  </a>
                  .
                </p>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
