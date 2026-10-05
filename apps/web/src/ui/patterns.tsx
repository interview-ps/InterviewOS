import type { ReactNode } from "react";
import { Timeline, Typography } from "antd";
import type { UITone as Tone } from "@interview-os/frontend-types";

import { Bar, Card, Pill } from "./index";

/* Reusable product patterns. These compose the antd-backed primitives in
   ./index into the recurring Interview OS shapes (command centre, priorities,
   readiness, deltas, evidence) so pages stop hand-rolling card stacks. */

const TONE_COLOR: Record<Tone, string> = {
  green: "var(--interview-success)",
  amber: "var(--interview-warning)",
  red: "var(--interview-danger)",
  blue: "var(--interview-brand)",
  muted: "var(--interview-text-muted)",
};

/** Readiness-style 0–1 value → "64%" (or "—" when unknown). */
export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

/** Direction of a numeric series (ignores nulls). */
export function trendOf(
  values: (number | null | undefined)[],
): "up" | "down" | "flat" | null {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length < 2) return null;
  const first = nums[0];
  const last = nums[nums.length - 1];
  if (first === undefined || last === undefined) return null;
  if (last > first + 0.005) return "up";
  if (last < first - 0.005) return "down";
  return "flat";
}

/** "interview_answer" → "Interview answer". */
export function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Bar tone for a readiness value. */
export function readinessBarTone(value: number | null | undefined): "blue" | "green" | "amber" | "muted" {
  if (value === null || value === undefined) return "muted";
  if (value >= 0.6) return "green";
  if (value >= 0.35) return "blue";
  return "amber";
}

/** "interview_answer" → "Interview answer"; camelCase → spaced; prefers a real label. */
export function displayLabel(id: string, label?: string | null): string {
  if (label && label.trim()) return label;
  const last = id.split(/[./]/).pop() ?? id;
  return last
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Plain-language interpretation of a readiness number (never a bare score). */
export function readinessVerdict(
  overall: number,
  coverageRate: number | null,
): string {
  if (coverageRate !== null && coverageRate < 0.5) return "Not enough evidence yet";
  if (overall >= 0.75) return "Ready to interview";
  if (overall >= 0.5) return "Nearly ready";
  return "Not ready for a full mock yet";
}

/* -- headings -------------------------------------------------------------- */

export function SectionHeading({
  title,
  description,
  count,
  action,
  level = 5,
}: {
  title: ReactNode;
  description?: ReactNode;
  count?: number;
  action?: ReactNode;
  level?: 3 | 4 | 5;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <Typography.Title level={level} style={{ margin: 0 }}>
          {title}
          {count !== undefined && (
            <Typography.Text
              type="secondary"
              style={{ fontWeight: 400, fontSize: 14, marginInlineStart: 8 }}
            >
              ({count})
            </Typography.Text>
          )}
        </Typography.Title>
        {description && (
          <Typography.Text type="secondary">{description}</Typography.Text>
        )}
      </div>
      {action && (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      )}
    </div>
  );
}

/* -- callouts -------------------------------------------------------------- */

export function Callout({
  tone = "blue",
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="note"
      style={{
        borderInlineStart: `3px solid ${TONE_COLOR[tone]}`,
        background: "var(--interview-surface-hover)",
        borderRadius: "var(--interview-radius-sm)",
        padding: "10px 14px",
      }}
    >
      {title && (
        <Typography.Text
          strong
          style={{ display: "block", color: TONE_COLOR[tone], marginBottom: 2 }}
        >
          {title}
        </Typography.Text>
      )}
      <Typography.Text type="secondary">{children}</Typography.Text>
    </div>
  );
}

/* -- status ---------------------------------------------------------------- */

export function StatusDot({ tone = "muted" }: { tone?: Tone }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: TONE_COLOR[tone] }}
    />
  );
}

/* -- readiness change ------------------------------------------------------ */

export type Delta = {
  key?: string;
  label: ReactNode;
  before: number | null;
  after: number | null;
};

/** `Caching 48% → 64%` rows, tone by direction. The signature feedback shape. */
export function DeltaList({
  items,
  empty = "No changes yet.",
}: {
  items: Delta[];
  empty?: ReactNode;
}) {
  if (items.length === 0) {
    return <Typography.Text type="secondary">{empty}</Typography.Text>;
  }
  return (
    <ul className="space-y-1.5">
      {items.map((d, i) => {
        const dir =
          d.before === null || d.after === null
            ? "flat"
            : d.after > d.before + 0.005
              ? "up"
              : d.after < d.before - 0.005
                ? "down"
                : "flat";
        const color =
          dir === "up"
            ? TONE_COLOR.green
            : dir === "down"
              ? TONE_COLOR.red
              : TONE_COLOR.muted;
        const arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "→";
        const word =
          dir === "up" ? "improved" : dir === "down" ? "dropped" : "unchanged";
        return (
          <li
            key={d.key ?? i}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="min-w-0 truncate">{d.label}</span>
            <span className="shrink-0 tabular-nums">
              <Typography.Text type="secondary">{pct(d.before)}</Typography.Text>
              <span aria-hidden className="mx-1">
                →
              </span>
              <Typography.Text strong style={{ color }}>
                {pct(d.after)}
              </Typography.Text>
              <span aria-hidden className="ml-1" style={{ color }}>
                {arrow}
              </span>
              <span className="sr-only">{word}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* -- priorities ------------------------------------------------------------ */

export type PriorityItem = {
  key: string;
  label: ReactNode;
  statusLabel?: string;
  tone?: Tone;
  readiness?: number | null;
  note?: ReactNode;
  action?: ReactNode;
};

export function PriorityList({
  items,
  empty = "No priorities yet.",
}: {
  items: PriorityItem[];
  empty?: ReactNode;
}) {
  if (items.length === 0) {
    return <Typography.Text type="secondary">{empty}</Typography.Text>;
  }
  return (
    <ul className="space-y-3">
      {items.map((p) => (
        <li key={p.key}>
          <div className="flex items-center justify-between gap-2">
            <Typography.Text strong className="min-w-0 truncate">
              {p.label}
            </Typography.Text>
            {p.statusLabel && <Pill tone={p.tone ?? "muted"}>{p.statusLabel}</Pill>}
          </div>
          <div className="mt-1">
            <Bar value={p.readiness ?? 0} tone={readinessBarTone(p.readiness)} />
          </div>
          {p.note && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {p.note}
            </Typography.Text>
          )}
          {p.action && <div className="mt-1.5">{p.action}</div>}
        </li>
      ))}
    </ul>
  );
}

/* -- command centre -------------------------------------------------------- */

export function NextActionCard({
  action,
  why,
  skill,
  readiness,
  impact,
  cta,
}: {
  action: ReactNode;
  why?: ReactNode;
  skill?: ReactNode;
  readiness?: number | null;
  impact?: ReactNode;
  cta?: ReactNode;
}) {
  return (
    <Card className="interview-next-action">
      <Typography.Text
        style={{
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--interview-brand)",
          fontWeight: 600,
        }}
      >
        Next best action
      </Typography.Text>
      <Typography.Title level={4} style={{ margin: "6px 0 10px" }}>
        {action}
      </Typography.Title>
      {why && (
        <div className="mb-3">
          <Callout title="Why this, now">{why}</Callout>
        </div>
      )}
      {(skill || readiness !== undefined || impact) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          {skill && (
            <span className="text-muted">
              Skill: <Typography.Text strong>{skill}</Typography.Text>
            </span>
          )}
          {readiness !== undefined && (
            <span className="text-muted">
              Current readiness:{" "}
              <Typography.Text strong>{pct(readiness)}</Typography.Text>
            </span>
          )}
          {impact && (
            <span className="text-muted">
              Impact: <Typography.Text strong>{impact}</Typography.Text>
            </span>
          )}
        </div>
      )}
      {cta && <div className="flex flex-wrap items-center gap-2">{cta}</div>}
    </Card>
  );
}

export function ReadinessHero({
  overall,
  confidence,
  verdict,
  note,
  trend,
  strongest,
  risks,
  updatedAt,
  action,
}: {
  overall: number;
  confidence: number;
  verdict?: ReactNode;
  note?: ReactNode;
  trend?: "up" | "down" | "flat" | null;
  strongest?: { label: ReactNode; value: number | null }[];
  risks?: { label: ReactNode; value: number | null }[];
  updatedAt?: string;
  action?: ReactNode;
}) {
  const arrow = trend === "up" ? "↑" : trend === "down" ? "↓" : trend ? "→" : "";
  const color =
    trend === "up"
      ? TONE_COLOR.green
      : trend === "down"
        ? TONE_COLOR.red
        : TONE_COLOR.muted;
  const column = (
    heading: string,
    items: { label: ReactNode; value: number | null }[] | undefined,
  ) => (
    <div>
      <Typography.Text
        strong
        style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}
      >
        {heading}
      </Typography.Text>
      <ul className="mt-1 space-y-1 text-sm">
        {items && items.length > 0 ? (
          items.slice(0, 3).map((s, i) => (
            <li key={i} className="flex justify-between gap-2">
              <span className="min-w-0 truncate">{s.label}</span>
              <Typography.Text type="secondary">{pct(s.value)}</Typography.Text>
            </li>
          ))
        ) : (
          <li className="text-muted">—</li>
        )}
      </ul>
    </div>
  );
  return (
    <Card className="interview-readiness-hero">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          {verdict && (
            <Typography.Text strong style={{ display: "block", fontSize: 15 }}>
              {verdict}
            </Typography.Text>
          )}
          <div className="mt-1 flex items-baseline gap-2">
            <span
              style={{
                fontSize: 40,
                fontWeight: 700,
                lineHeight: 1,
                color: "var(--interview-brand)",
              }}
            >
              {Math.round(overall * 100)}%
            </span>
            <span className="text-muted">estimated readiness</span>
            {arrow && (
              <span aria-hidden style={{ color, fontSize: 20, fontWeight: 700 }}>
                {arrow}
              </span>
            )}
            {arrow && (
              <span className="sr-only">
                {trend === "up" ? "improving" : trend === "down" ? "declining" : "steady"}
              </span>
            )}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            confidence {Math.round(confidence * 100)}%
            {updatedAt ? ` · updated ${new Date(updatedAt).toLocaleDateString()}` : ""}
          </Typography.Text>
          {note && (
            <Typography.Text
              type="secondary"
              style={{ display: "block", fontSize: 12, marginTop: 2 }}
            >
              {note}
            </Typography.Text>
          )}
        </div>
        {action}
      </div>
      {(strongest || risks) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {column("Strongest", strongest)}
          {column("Biggest risks", risks)}
        </div>
      )}
    </Card>
  );
}

/** Status counts: keep "not assessed" visibly different from "needs work". */
export function StatusBuckets({
  counts,
}: {
  counts: { strong: number; developing: number; weak: number; unknown: number };
}) {
  const items: { key: keyof typeof counts; label: string; color: string }[] = [
    { key: "strong", label: "strong", color: TONE_COLOR.green },
    { key: "developing", label: "improving", color: TONE_COLOR.blue },
    { key: "weak", label: "needs work", color: TONE_COLOR.amber },
    { key: "unknown", label: "not assessed", color: TONE_COLOR.muted },
  ];
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: i.color }}
          />
          <Typography.Text strong>{counts[i.key]}</Typography.Text>
          <span className="text-muted">{i.label}</span>
        </li>
      ))}
    </ul>
  );
}

/* -- evidence ----------------------------------------------------------------- */

export type EvidenceEntry = {
  id: string;
  observation: string;
  score?: number | null;
  confidence?: number;
  type?: string;
  createdAt?: string;
  link?: ReactNode;
};

export function EvidenceTimeline({
  items,
  empty = "No evidence recorded yet.",
}: {
  items: EvidenceEntry[];
  empty?: ReactNode;
}) {
  if (items.length === 0) {
    return <Typography.Text type="secondary">{empty}</Typography.Text>;
  }
  return (
    <Timeline
      items={items.map((e) => ({
        color:
          e.score === null || e.score === undefined
            ? "gray"
            : e.score >= 0.6
              ? "green"
              : e.score >= 0.4
                ? "blue"
                : "red",
        children: (
          <div className="text-sm">
            <div className="flex items-center justify-between gap-2">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {e.type ? humanize(e.type) : "Evidence"}
                {e.createdAt ? ` · ${e.createdAt.slice(0, 10)}` : ""}
                {e.confidence !== undefined
                  ? ` · ${Math.round(e.confidence * 100)}% confident`
                  : ""}
              </Typography.Text>
              {e.score !== null && e.score !== undefined && (
                <Pill
                  tone={e.score >= 0.6 ? "green" : e.score >= 0.4 ? "amber" : "red"}
                >
                  {Math.round(e.score * 100)}%
                </Pill>
              )}
            </div>
            <div>{e.observation}</div>
            {e.link && <div className="mt-0.5">{e.link}</div>}
          </div>
        ),
      }))}
    />
  );
}

/* -- misc ------------------------------------------------------------------- */

/** Small labelled value used in dense summary rows. */
export function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      <div>{children}</div>
    </div>
  );
}

