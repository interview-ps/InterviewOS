import type { ReactNode } from "react";

/**
 * Readiness chart kit — antd-free, plain SVG + design tokens, so it renders
 * identically in the app and inside sandboxed plugin frames.
 *
 * The product is an evidence graph, so the encodings are deliberately explicit:
 *  - a readiness history line with a confidence band (uncertainty, not a score
 *    range) and an optional target marker;
 *  - skill-dimension bars with a target tick and a "provisional" hatch when
 *    confidence is low, keeping a high score visibly distinct from a confident
 *    score;
 *  - gap severity bars, where length is `importance × gap` and tone is severity.
 */

export const CONFIDENCE_SPREAD = 0.25;
/** Below this confidence a bar/dot is drawn as provisional. */
export const LOW_CONFIDENCE = 0.4;

export type ReadinessStatusLike = "unknown" | "weak" | "developing" | "strong";
export type GapSeverityLike = "low" | "medium" | "high";

export interface HistoryPoint {
  score: number | null;
  confidence: number;
  computedAt: string;
}

export interface DimensionBar {
  skillId: string;
  label: string;
  score: number | null;
  confidence: number;
  status: ReadinessStatusLike;
}

export interface GapBar {
  skillId: string;
  label: string;
  severity: GapSeverityLike;
  importance: number;
  gap: number;
  currentScore: number | null;
  targetScore: number;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The uncertainty band around a score. Width grows as confidence falls, so a
 * high score with low confidence renders as a wide, uncertain band.
 */
export function confidenceBand(
  score: number,
  confidence: number,
  spread = CONFIDENCE_SPREAD,
): { lower: number; upper: number } {
  const width = (1 - clamp01(confidence)) * spread;
  return { lower: clamp01(score - width), upper: clamp01(score + width) };
}

export function severityTone(severity: GapSeverityLike): string {
  if (severity === "high") return "var(--color-danger)";
  if (severity === "medium") return "var(--color-accent)";
  return "var(--color-neutral)";
}

export function statusTone(status: ReadinessStatusLike): string {
  if (status === "strong") return "var(--color-green)";
  if (status === "developing") return "var(--color-blue)";
  if (status === "weak") return "var(--color-accent)";
  return "var(--color-divider)";
}

export function isLowConfidence(confidence: number): boolean {
  return confidence < LOW_CONFIDENCE;
}

export interface HistorySummary {
  count: number;
  latest: number | null;
  first: number | null;
  lowConfidence: number;
}

export function historySummary(
  points: HistoryPoint[],
  lowBelow = LOW_CONFIDENCE,
): HistorySummary {
  const scored = points.filter((p) => p.score !== null) as (HistoryPoint & {
    score: number;
  })[];
  return {
    count: scored.length,
    first: scored[0]?.score ?? null,
    latest: scored[scored.length - 1]?.score ?? null,
    lowConfidence: scored.filter((p) => p.confidence < lowBelow).length,
  };
}

/* -- geometry -------------------------------------------------------------- */

const CHART_W = 360;
const CHART_H = 112;
const PAD = { top: 12, right: 12, bottom: 14, left: 12 };

function xFor(index: number, count: number): number {
  const inner = CHART_W - PAD.left - PAD.right;
  if (count <= 1) return PAD.left + inner / 2;
  return PAD.left + (index * inner) / (count - 1);
}

function yFor(value: number): number {
  return PAD.top + (1 - clamp01(value)) * (CHART_H - PAD.top - PAD.bottom);
}

/* -- chart ----------------------------------------------------------------- */

export function ReadinessHistoryChart({
  points,
  target,
  label,
}: {
  points: HistoryPoint[];
  target?: number | null;
  label?: ReactNode;
}) {
  const summary = historySummary(points);
  if (summary.count === 0) {
    return <p className="text-sm text-muted">No score history yet.</p>;
  }

  const n = points.length;
  const plotted = points
    .map((p, i) => ({ i, p }))
    .filter(({ p }) => p.score !== null) as { i: number; p: HistoryPoint & { score: number } }[];

  const linePath = plotted
    .map(({ i, p }, k) => `${k === 0 ? "M" : "L"}${xFor(i, n).toFixed(1)},${yFor(p.score).toFixed(1)}`)
    .join(" ");

  const upper = plotted.map(({ i, p }) => {
    const band = confidenceBand(p.score, p.confidence);
    return `${xFor(i, n).toFixed(1)},${yFor(band.upper).toFixed(1)}`;
  });
  const lower = plotted.map(({ i, p }) => {
    const band = confidenceBand(p.score, p.confidence);
    return `${xFor(i, n).toFixed(1)},${yFor(band.lower).toFixed(1)}`;
  });
  const bandPath =
    plotted.length >= 2 ? `M${[...upper, ...[...lower].reverse()].join("L")}Z` : null;

  const aria =
    `Readiness history: ${summary.count} assessment${summary.count === 1 ? "" : "s"}` +
    `, latest ${summary.latest === null ? "unknown" : `${Math.round(summary.latest * 100)}%`}` +
    (summary.lowConfidence > 0 ? `, ${summary.lowConfidence} with low confidence` : "");

  return (
    <figure>
      {label && (
        <figcaption className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
          {label}
        </figcaption>
      )}
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label={aria}>
        <line
          x1={PAD.left}
          y1={yFor(0)}
          x2={CHART_W - PAD.right}
          y2={yFor(0)}
          style={{ stroke: "var(--color-divider)" }}
          strokeWidth={1}
        />
        <line
          x1={PAD.left}
          y1={yFor(1)}
          x2={CHART_W - PAD.right}
          y2={yFor(1)}
          style={{ stroke: "var(--color-divider)" }}
          strokeWidth={1}
        />
        {bandPath && (
          <path d={bandPath} style={{ fill: "rgba(var(--brand-rgb), 0.12)" }} stroke="none" />
        )}
        {target !== null && target !== undefined && (
          <>
            <line
              x1={PAD.left}
              y1={yFor(target)}
              x2={CHART_W - PAD.right}
              y2={yFor(target)}
              style={{ stroke: "var(--color-muted)" }}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text
              x={CHART_W - PAD.right}
              y={yFor(target) - 3}
              textAnchor="end"
              style={{ fontSize: 9, fill: "var(--color-muted)" }}
            >
              target {Math.round(target * 100)}%
            </text>
          </>
        )}
        <path
          d={linePath}
          fill="none"
          style={{ stroke: "var(--color-blue)" }}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {plotted.map(({ i, p }) => (
          <circle
            key={i}
            cx={xFor(i, n)}
            cy={yFor(p.score)}
            r={2.5}
            style={{
              fill: isLowConfidence(p.confidence)
                ? "var(--color-surface)"
                : "var(--color-blue)",
              stroke: "var(--color-blue)",
            }}
            strokeWidth={1.5}
          />
        ))}
      </svg>
      <p className="mt-1 text-[11px] text-muted">
        Shading shows uncertainty — wider where evidence confidence is lower.
      </p>
    </figure>
  );
}

/* -- primitive bar --------------------------------------------------------- */

/**
 * A 0–1 bar with an optional target tick and a provisional hatch for
 * low-confidence values. The single bar primitive behind the dimension list.
 */
export function TargetBar({
  value,
  tone,
  target,
  confidence,
}: {
  value: number | null;
  tone: string;
  target?: number | null;
  confidence?: number;
}) {
  const provisional = confidence !== undefined && isLowConfidence(confidence);
  return (
    <span
      className="relative block h-2 w-full overflow-hidden rounded-full bg-[var(--color-divider)]"
      {...(value === null
        ? {}
        : {
            role: "progressbar",
            "aria-valuenow": Math.round(clamp01(value) * 100),
            "aria-valuemin": 0,
            "aria-valuemax": 100,
          })}
    >
      {value !== null && (
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.round(clamp01(value) * 100)}%`,
            background: tone,
            ...(provisional
              ? {
                  backgroundImage:
                    "repeating-linear-gradient(45deg, rgba(255,255,255,0.45) 0 3px, transparent 3px 6px)",
                }
              : {}),
          }}
        />
      )}
      {target !== null && target !== undefined && (
        <span
          aria-hidden
          className="absolute inset-y-0 w-[2px] bg-[var(--color-navy)]"
          style={{ left: `calc(${Math.round(clamp01(target) * 100)}% - 1px)` }}
        />
      )}
    </span>
  );
}

/* -- dimension list -------------------------------------------------------- */

export function SkillDimensionBars({
  dimensions,
  targets,
  selectedId,
  onSelect,
}: {
  dimensions: DimensionBar[];
  targets?: Record<string, number>;
  selectedId?: string | null;
  onSelect?: (skillId: string) => void;
}) {
  if (dimensions.length === 0) {
    return <p className="text-sm text-muted">No skill dimensions yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {dimensions.map((d) => {
        const row = (
          <>
            <span className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-navy">
                {d.label}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {d.score === null ? "not assessed" : `${Math.round(clamp01(d.score) * 100)}%`}
              </span>
            </span>
            <span className="mt-1 block">
              <TargetBar
                value={d.score}
                tone={statusTone(d.status)}
                target={targets?.[d.skillId]}
                confidence={d.confidence}
              />
            </span>
          </>
        );
        return (
          <li key={d.skillId}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(d.skillId)}
                aria-current={selectedId === d.skillId ? "true" : undefined}
                className={`block w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left ${
                  selectedId === d.skillId
                    ? "bg-[var(--color-tint)]"
                    : "hover:bg-[var(--color-hover)]"
                }`}
              >
                {row}
              </button>
            ) : (
              <span className="block px-2 py-1.5">{row}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* -- gap severity ---------------------------------------------------------- */

/**
 * Gap severity encoding: bar length is `importance × gap` (the driver of the
 * backend's severity), tone is the severity band, and the row reads
 * `current → target`.
 */
export function GapSeverityBars({
  gaps,
  limit,
  meta,
  empty = "No gaps detected — nice.",
}: {
  gaps: GapBar[];
  limit?: number;
  meta?: (gap: GapBar) => ReactNode;
  empty?: ReactNode;
}) {
  const items = limit ? gaps.slice(0, limit) : gaps;
  if (items.length === 0) {
    return <p className="p-3 text-sm text-muted">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-divider">
      {items.map((g) => (
        <li key={g.skillId} className="px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-navy">{g.label}</span>
            <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted">
              {g.severity}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <TargetBar value={clamp01(g.importance * g.gap)} tone={severityTone(g.severity)} />
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {g.currentScore === null ? "not assessed" : `${Math.round(clamp01(g.currentScore) * 100)}%`}{" "}
              → {Math.round(clamp01(g.targetScore) * 100)}%
            </span>
          </div>
          {meta && <p className="mt-0.5 text-xs text-muted">{meta(g)}</p>}
        </li>
      ))}
    </ul>
  );
}
