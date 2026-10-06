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
  EmptyState,
  ErrorNote,
  Panel,
  Pill,
  ScreenToolbar,
  Skeleton,
  Spinner,
  SplitPane,
  Workspace,
  skillLabel,
  toast,
} from "@/components/ui";
import { PluginSlot } from "@/components/plugin-ui";

const STATUS_ICON = { pass: "✓", warn: "!", fail: "✗" } as const;
const STATUS_CLS = {
  pass: "bg-green-tint text-green",
  warn: "bg-[#fdf3e7] text-accent",
  fail: "bg-[#fdeef2] text-danger",
} as const;

type TabKey = "overview" | "bullets" | "role";

function CheckRow({ check }: { check: AtsCheck }) {
  return (
    <li className="flex items-start gap-2.5 border-b border-line py-1.5 text-[13px] last:border-b-0">
      <span
        aria-label={check.status}
        className={`mt-0.5 flex shrink-0 items-center justify-center rounded-full text-[0.6rem] font-bold ${STATUS_CLS[check.status]}`}
        style={{ width: 18, height: 18 }}
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
  const [tab, setTab] = useState<TabKey>("overview");
  const [selected, setSelected] = useState(0);

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
      .then((r) => {
        setReview(r);
        setSelected(0);
        setTab("overview");
      })
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
      <Workspace toolbar={<ScreenToolbar title="Resume coach" />} bodyClassName="space-y-3">
        <Skeleton className="h-40 w-full" />
      </Workspace>
    );
  }

  const ats = review?.ats;
  const atsVerdict = (s: number) => (s >= 70 ? "Good" : s >= 45 ? "Fair" : "Needs work");
  const fixes = ats
    ? [
        ...ats.checks
          .filter((c) => c.status === "fail")
          .map((c) => ({
            key: c.id,
            title: c.label,
            why: c.detail,
            cta: "Fix resume",
            href: "#ats-check",
          })),
        ...(ats.keywordCoverage.missing.length > 0
          ? [
              {
                key: "keywords",
                title: "Add role-relevant experience",
                why: `${ats.keywordCoverage.missing
                  .map((k) => k.label)
                  .slice(0, 3)
                  .join(", ")} aren't represented in your resume.`,
                cta: "Review missing skills",
                href: "#keywords",
              },
            ]
          : []),
        ...ats.checks
          .filter((c) => c.status === "warn")
          .map((c) => ({
            key: c.id,
            title: c.label,
            why: c.detail,
            cta: "Review",
            href: "#ats-check",
          })),
      ].slice(0, 3)
    : [];

  const suggestion = review?.suggestions[selected];

  return (
    <Workspace
      scroll={false}
      toolbar={
        <ScreenToolbar
          title="Resume coach"
          subtitle="ATS check, bullet rewrites and tailoring — grounded only in your resume."
          tabs={
            review ? (
              <div className="flex items-center gap-1">
                {(
                  [
                    ["overview", "Overview"],
                    ["bullets", "Bullet suggestions"],
                    ["role", "Role match"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-current={tab === key ? "page" : undefined}
                    onClick={() => setTab(key)}
                    className={`-mb-px border-b-2 px-2.5 py-1.5 text-[13px] ${
                      tab === key
                        ? "border-blue font-semibold text-navy"
                        : "border-transparent text-muted hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : undefined
          }
          actions={
            hasResume !== false ? (
              <>
                <Button size="small" onClick={runReview} disabled={busy} data-testid="run-review">
                  {review ? "Run review again" : "Run review"}
                </Button>
                {busy && <Spinner label={`${stage ?? "starting"}…`} />}
                {review && (
                  <span className="text-xs text-muted">
                    Last reviewed {new Date(review.createdAt).toLocaleString()}
                  </span>
                )}
              </>
            ) : undefined
          }
        />
      }
    >
      <ErrorNote error={error} />

      <p
        data-testid="resume-banner"
        className="mt-3 shrink-0 rounded-[var(--radius-sm)] border border-line bg-tint px-3 py-1.5 text-xs text-muted"
      >
        Interview OS never invents facts — placeholders like{" "}
        <code className="text-accent">[add metric]</code> are for you to fill in truthfully.
      </p>

      {hasResume === false && (
        <div className="mt-3">
          <Panel>
            <EmptyState
              title="No resume on file"
              description="Set up your workspace on the Target page first — the coach reviews the resume you upload there."
              action={
                <a href="/target">
                  <Button variant="secondary" size="small">Open target</Button>
                </a>
              }
            />
          </Panel>
        </div>
      )}

      {hasResume !== false && !review && !busy && (
        <div className="mt-3 max-w-4xl">
          <Panel title="What the review does">
            <p className="text-[13px] text-muted">
              It scores your resume against ATS basics, suggests stronger bullets using only facts
              already in it, and shows how well it is tailored to your target role. It takes a few
              seconds.
            </p>
          </Panel>
        </div>
      )}

      {review && tab === "overview" && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Panel title="ATS check" data-testid="ats-card" className="lg:col-span-1">
            <div className="flex items-center gap-3">
              <div
                data-testid="ats-score"
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-4 border-blue text-lg font-bold text-navy"
              >
                {review.ats.score}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-muted">
                  ATS readiness {review.ats.score}/100 — {atsVerdict(review.ats.score)}.
                </p>
                <div className="mt-1">
                  <Bar
                    value={review.ats.score / 100}
                    tone={review.ats.score >= 70 ? "green" : review.ats.score >= 45 ? "blue" : "amber"}
                  />
                </div>
              </div>
            </div>
            <div id="ats-check" className="mt-3">
              <ul>
                {review.ats.checks.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </ul>
            </div>
          </Panel>

          <Panel title="Highest-impact fixes">
            {fixes.length === 0 ? (
              <p className="text-sm text-muted">No blocking issues — nice.</p>
            ) : (
              <ol className="space-y-2">
                {fixes.map((f, i) => (
                  <li key={f.key} className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-xs text-muted">
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-ink">{f.title}</p>
                      <p className="text-xs text-muted">{f.why}</p>
                      <a href={f.href} className="mt-0.5 inline-block text-xs text-blue underline">
                        {f.cta}
                      </a>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Required-skill keywords" className="lg:col-span-2">
            <div id="keywords">
              {review.ats.keywordCoverage.present.length === 0 &&
              review.ats.keywordCoverage.missing.length === 0 ? (
                <p className="text-sm text-muted">The target role lists no required skills.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {review.ats.keywordCoverage.present.map((k) => (
                    <li key={k.skillId} title={`found: “${k.snippet.slice(0, 90)}”`}>
                      <Pill tone="green">✓ {k.label}</Pill>
                    </li>
                  ))}
                  {review.ats.keywordCoverage.missing.map((k) => (
                    <li key={k.skillId} data-missing-skill={k.skillId}>
                      <Pill tone="amber">! {k.label}</Pill>
                    </li>
                  ))}
                </ul>
              )}
              {review.ats.keywordCoverage.missing.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  “!” skills are not in your resume — if you have the experience, add it; otherwise
                  see <a className="text-blue underline" href="/prepare">Prepare</a>.
                </p>
              )}
            </div>
          </Panel>
        </div>
      )}

      {review && tab === "bullets" && (
        <div data-testid="suggestions-card" className="mt-3 flex min-h-0 flex-1 flex-col">
        <SplitPane
          leftWidth={340}
          className="flex-1"
          left={
            <>
              <div className="shrink-0 px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                {review.suggestions.length} bullets
              </div>
              <div className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-card)] border border-line bg-surface">
                {review.suggestions.length === 0 ? (
                  <p className="p-3 text-sm text-muted">No weak bullets found — nice.</p>
                ) : (
                  <ul>
                    {review.suggestions.map((s, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => setSelected(i)}
                          aria-current={selected === i ? "true" : undefined}
                          className={`w-full border-b border-line px-2.5 py-1.5 text-left text-[13px] last:border-b-0 ${
                            selected === i ? "bg-tint" : "hover:bg-tint"
                          }`}
                        >
                          <span className="block">{s.original}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          }
          right={
            <Panel className="flex-1" title={suggestion ? "Comparison" : "Select a bullet"}>
              {/* `suggestions-card` content lives in the list; the comparison
                  keeps the full text of the selected bullet only. */}
              {suggestion && (
                <div data-testid="suggestions-card-detail" className="space-y-3">
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                      Original
                    </div>
                    <p className="text-sm text-muted">{suggestion.original}</p>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-green">
                        Suggested
                      </span>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => copy(selected, suggestion.improved)}
                      >
                        {copied === selected ? "Copied!" : "Copy"}
                      </Button>
                    </div>
                    <p className="text-sm text-ink">
                      <Highlighted text={suggestion.improved} />
                    </p>
                  </div>
                  {suggestion.dropped && (
                    <p className="rounded-[var(--radius-sm)] bg-[#fdeef2] px-2 py-1 text-xs text-danger">
                      Dropped to avoid inventing a fact: {suggestion.dropped}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {suggestion.skillIds.map((id) => (
                      <Pill key={id} tone="blue">{skillLabel(id)}</Pill>
                    ))}
                    {suggestion.rationale && (
                      <span className="text-xs text-muted">{suggestion.rationale}</span>
                    )}
                  </div>
                </div>
              )}
            </Panel>
          }
        />
        </div>
      )}

      {review && tab === "role" && (
        <div className="mt-3 max-w-5xl space-y-3">
          {review.tailoring ? (
            <Panel data-testid="tailoring-card">
              <p className="text-[13px] text-ink">{review.tailoring.summary}</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {review.tailoring.emphasize.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-[13px] font-semibold text-navy">Emphasize</h3>
                    <ul className="list-inside list-disc space-y-0.5 text-[13px] text-muted">
                      {review.tailoring.emphasize.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
                {review.tailoring.deEmphasize.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-[13px] font-semibold text-navy">De-emphasize</h3>
                    <ul className="list-inside list-disc space-y-0.5 text-[13px] text-muted">
                      {review.tailoring.deEmphasize.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
              </div>
              {review.tailoring.alignment.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                        <th className="py-1.5 pr-4">Requirement</th>
                        <th className="py-1.5 pr-4">In your resume?</th>
                        <th className="py-1.5">Suggestion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.tailoring.alignment.map((a, i) => (
                        <tr key={i} className="border-b border-line/60">
                          <td className="py-1.5 pr-4 align-top font-medium text-ink">{a.requirement}</td>
                          <td className="py-1.5 pr-4 align-top text-muted">
                            {a.resumeEvidence ? <span title={a.resumeEvidence}>✓ yes</span> : "— not yet"}
                          </td>
                          <td className="py-1.5 align-top text-muted">
                            <Highlighted text={a.suggestion} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {review.tailoring.prepGaps.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  Gaps for preparation, not the resume:{" "}
                  {review.linkedGapSkillIds.length > 0
                    ? review.linkedGapSkillIds.map((id) => skillLabel(id)).join(", ")
                    : review.tailoring.prepGaps.join(", ")}
                  {" — see "}
                  <a className="text-blue underline" href="/prepare">Prepare</a>.
                </p>
              )}
            </Panel>
          ) : (
            <Panel>
              <EmptyState title="No tailoring yet" description="Run a review to compare your resume with the role." />
            </Panel>
          )}
        </div>
      )}

      <div className="mt-3 shrink-0">
        <PluginSlot slot="resume.tabs" />
      </div>
    </Workspace>
  );
}
