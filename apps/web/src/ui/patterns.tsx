import { Fragment, useState, type ReactNode } from "react";
import { App, Collapse, Typography } from "antd";
import type { UITone as Tone } from "@interview-os/frontend-types";

import { Bar, Button, Pill } from "./index";

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

/**
 * Safe inline rich text: renders `code` spans and **bold** without any HTML
 * injection. Used for plugin/AI text (coding statements, evaluations) that
 * otherwise shows literal backticks.
 */
export function RichText({
  text,
  className = "",
}: {
  text: string | null | undefined;
  className?: string;
}) {
  const value = text ?? "";
  const lines = value.split("\n");
  return (
    <span className={className}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {renderInline(line)}
        </Fragment>
      ))}
    </span>
  );
}

function renderInline(line: string): ReactNode {
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-page px-1 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.length > 3 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

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

/**
 * Candidate-facing explanation of a gap, composed from the structured fields.
 * The backend `reason` ("no evidence for required skill; senior target is 0.8")
 * is written for API consumers, not for people.
 */
export function gapReason(g: {
  currentScore: number | null;
  targetScore: number;
  severity: string;
}): string {
  const target = `${Math.round(g.targetScore * 100)}%`;
  if (g.currentScore === null || g.currentScore === undefined) {
    return `No evidence yet — your target expects ${target} for this skill.`;
  }
  const current = `${Math.round(g.currentScore * 100)}%`;
  if (g.severity === "low") {
    return `You're at ${current}, close to your target of ${target}.`;
  }
  return `You're at ${current}; your target expects ${target}.`;
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

/**
 * Canonical readiness-change rendering. A value with no prior measurement is a
 * *first assessment*, never a fake change. Never shows an arrow without a
 * prior measurement.
 */
export function DeltaText({
  before,
  after,
  compact = false,
}: {
  before: number | null;
  after: number | null;
  compact?: boolean;
}) {
  if (after === null || after === undefined) {
    return <Typography.Text type="secondary">Not measured</Typography.Text>;
  }
  if (before === null || before === undefined) {
    return (
      <span className="tabular-nums">
        {!compact && (
          <Typography.Text type="secondary">First assessment: </Typography.Text>
        )}
        <Typography.Text strong>{pct(after)}</Typography.Text>
      </span>
    );
  }
  const diff = Math.round((after - before) * 100);
  if (diff === 0) {
    return (
      <span className="tabular-nums">
        <Typography.Text type="secondary">{pct(before)}</Typography.Text>
        <span aria-hidden className="mx-1">
          →
        </span>
        <Typography.Text strong>{pct(after)}</Typography.Text>
        <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
          No change
        </Typography.Text>
      </span>
    );
  }
  const up = diff > 0;
  const color = up ? TONE_COLOR.green : TONE_COLOR.red;
  return (
    <span className="tabular-nums">
      <Typography.Text type="secondary">{pct(before)}</Typography.Text>
      <span aria-hidden className="mx-1">
        →
      </span>
      <Typography.Text strong style={{ color }}>
        {pct(after)}
      </Typography.Text>
      <Typography.Text style={{ color, marginInlineStart: 8 }}>
        {up ? "+" : "−"}
        {Math.abs(diff)} pp
      </Typography.Text>
      <span className="sr-only">
        {up ? "increased" : "decreased"} by {Math.abs(diff)} percentage points
      </span>
    </span>
  );
}

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
      {items.map((d, i) => (
        <li
          key={d.key ?? i}
          className="flex items-center justify-between gap-3 text-sm"
        >
          <span className="min-w-0 truncate">{d.label}</span>
          <span className="shrink-0">
            <DeltaText before={d.before} after={d.after} />
          </span>
        </li>
      ))}
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
            {p.readiness === null || p.readiness === undefined ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Not assessed yet — no evidence
              </Typography.Text>
            ) : (
              <Bar value={p.readiness} tone={readinessBarTone(p.readiness)} />
            )}
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

/* -- layout primitives ------------------------------------------------------ */

/**
 * A page section: heading + content, no nested card. The density contract's
 * building block — one prominent Card per screen, everything else is a Section.
 */
export function Section({
  title,
  description,
  action,
  children,
  level = 5,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  level?: 3 | 4 | 5;
}) {
  return (
    <section className="interview-section">
      {title && (
        <SectionHeading
          title={title}
          description={description}
          action={action}
          level={level}
        />
      )}
      {children}
    </section>
  );
}

/** One disclosure pattern for the whole app (antd Collapse, v6 `items`). */
export function CollapseList({
  items,
  defaultActiveKey,
  bordered = false,
}: {
  items: { key: string; label: ReactNode; children: ReactNode }[];
  defaultActiveKey?: string[];
  bordered?: boolean;
}) {
  return (
    <Collapse
      ghost={!bordered}
      defaultActiveKey={defaultActiveKey}
      items={items.map((i) => ({
        key: i.key,
        label: i.label,
        children: i.children,
      }))}
    />
  );
}

/** Copy a value with theme-aware feedback. */
export function CopyText({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const { message } = App.useApp();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="small"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            void message.success("Copied to clipboard");
            window.setTimeout(() => setCopied(false), 2000);
          },
          () => void message.error("Could not copy — select the text instead"),
        );
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

