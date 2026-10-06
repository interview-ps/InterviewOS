import { useState, type ReactNode } from "react";
import type { UITone } from "@interview-os/frontend-types";

export type Tone = UITone;

/* -- page header ---------------------------------------------------------- */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-navy">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* -- empty state ---------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-[0.6rem] border border-dashed border-line bg-page p-6 text-center">
      <p className="font-medium text-ink">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* -- loading skeletons ---------------------------------------------------- */

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-[0.5rem] bg-tint ${className}`}
    />
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <Card>
      <Skeleton className="mb-3 h-5 w-40" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="mb-2 h-3.5" />
      ))}
    </Card>
  );
}

/* -- surfaces ------------------------------------------------------------- */

export function Card({
  children,
  className = "",
  id,
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  "data-testid"?: string;
}) {
  return (
    <section
      id={id}
      data-testid={testId}
      className={`rounded-[var(--radius-card)] border border-line bg-surface p-3 ${className}`}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-sm font-semibold text-navy">{children}</h2>;
}

export function Bar({ value, tone = "blue" }: { value: number; tone?: "blue" | "green" | "amber" | "muted" }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color =
    tone === "green" ? "bg-green" : tone === "amber" ? "bg-accent" : tone === "muted" ? "bg-line" : "bg-blue";
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2.5 w-full overflow-hidden rounded-full bg-tint"
    >
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

const PILL_STYLES: Record<Tone, string> = {
  green: "bg-green-tint text-green",
  amber: "bg-[#fdf3e7] text-accent",
  red: "bg-[#fdeef2] text-danger",
  blue: "bg-tint text-blue",
  muted: "bg-page text-muted",
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${PILL_STYLES[tone]}`}>
      {children}
    </span>
  );
}
/** Back-compat alias — the design-system name is Badge. */
export const Pill = Badge;

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: number }).status
      : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: string }).code
      : undefined;
  const isUnavailable = status === 503;
  const isRuntimeFailure = status === 502 || code === "RUNTIME_FAILED";
  const isTimeout = status === 504 || code === "RUNTIME_TIMEOUT";
  const heading =
    isTimeout ? "The AI runtime timed out"
    : isRuntimeFailure ? "The AI runtime failed"
    : isUnavailable ? "The AI runtime is unavailable"
    : "Something went wrong";
  return (
    <div role="alert" className="rounded-[0.6rem] border border-accent/40 bg-[#fdf3e7] p-4 text-sm text-ink">
      <p className="font-medium text-accent">{heading}</p>
      <p className="mt-1 text-muted">{error instanceof Error ? error.message : String(error)}</p>
      {(isUnavailable || isRuntimeFailure || isTimeout) && (
        <p className="mt-2 text-muted">
          Check the active runtime under <a className="text-blue underline" href="/settings">Settings</a>, then retry.
          {isUnavailable && " See Settings for setup instructions."}
        </p>
      )}
    </div>
  );
}

export function Spinner({ label = "Working…" }: { label?: string }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-blue" aria-hidden />
      {label}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type,
  "data-testid": testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  type?: "button" | "submit";
  "data-testid"?: string;
}) {
  const styles = {
    primary: "bg-blue text-white hover:bg-blue-hover disabled:bg-line disabled:text-muted",
    secondary: "border border-line bg-surface text-ink hover:bg-tint disabled:text-muted",
    ghost: "text-blue hover:underline disabled:text-muted",
  }[variant];
  return (
    <button
      type={type ?? "button"}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed ${styles}`}
    >
      {children}
    </button>
  );
}

/* -- v0.4 platform widgets ------------------------------------------------- */

export function Stat({
  label,
  value,
  trend,
  tone = "blue",
}: {
  label: ReactNode;
  value: ReactNode;
  trend?: "up" | "down" | "flat";
  tone?: Tone;
}) {
  const arrow = trend === "up" ? "↑" : trend === "down" ? "↓" : trend === "flat" ? "→" : null;
  return (
    <div>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${tone === "muted" ? "text-muted" : "text-navy"}`}>
        {value}
        {arrow && <span className="ml-1 text-sm" aria-label={`trend ${trend}`}>{arrow}</span>}
      </p>
    </div>
  );
}

export function SkillScore({
  label,
  score,
  confidence,
}: {
  label: ReactNode;
  score: number | null;
  confidence?: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="text-sm text-muted">
          {score === null ? "not assessed" : `${Math.round(score * 100)}%`}
        </span>
      </div>
      <Bar value={score ?? 0} tone={score === null ? "muted" : score >= 0.6 ? "green" : score >= 0.35 ? "blue" : "amber"} />
      {confidence !== undefined && (
        <p className="mt-1 text-xs text-muted">confidence {Math.round(confidence * 100)}%</p>
      )}
    </div>
  );
}

export function EvidenceList({
  items,
}: {
  items: { skillId: string; observation: string; score?: number; createdAt?: string }[];
}) {
  if (items.length === 0) return <p className="text-sm text-muted">No evidence yet.</p>;
  return (
    <ul className="space-y-2">
      {items.map((e, i) => (
        <li key={i} className="rounded-[0.6rem] border border-line bg-page p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-ink">{e.skillId}</span>
            {e.score !== undefined && (
              <Badge tone={e.score >= 0.6 ? "green" : e.score >= 0.4 ? "amber" : "red"}>
                {Math.round(e.score * 100)}%
              </Badge>
            )}
          </div>
          <p className="mt-1 text-muted">{e.observation}</p>
          {e.createdAt && <p className="mt-0.5 text-xs text-muted">{e.createdAt.slice(0, 10)}</p>}
        </li>
      ))}
    </ul>
  );
}

export function InterviewQuestion({
  text,
  skill,
  difficulty,
  source,
}: {
  text: string;
  skill?: ReactNode;
  difficulty?: string;
  source?: { label: string; community?: boolean };
}) {
  return (
    <div className="rounded-[1rem] border border-line bg-surface p-5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {skill && <Badge tone="blue">{skill}</Badge>}
        {difficulty && <Badge tone="muted">{difficulty}</Badge>}
        {source && (
          <>
            <Badge tone="muted">{source.label}</Badge>
            {source.community && <Badge tone="amber">community</Badge>}
          </>
        )}
      </div>
      <p className="text-base text-ink">{text}</p>
    </div>
  );
}

export function Tabs({
  tabs,
  "data-testid": testId,
}: {
  tabs: { label: ReactNode; children: ReactNode }[];
  "data-testid"?: string;
}) {
  const [active, setActive] = useState(0);
  const current = Math.min(active, tabs.length - 1);
  return (
    <div data-testid={testId}>
      <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === current}
            onClick={() => setActive(i)}
            className={`rounded-t-[0.6rem] px-3 py-2 text-sm font-medium ${
              i === current
                ? "border-b-2 border-blue text-navy"
                : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tabs[current]?.children}</div>
    </div>
  );
}

/* -- compact desktop layout primitives ------------------------------------ */

/**
 * Screen chrome: a short toolbar with the title (and optional inline subtitle)
 * on the left, actions on the right, and tabs integrated directly beneath.
 * Replaces the stacked breadcrumb + title + subtitle + section-heading pattern.
 */
export function ScreenToolbar({
  title,
  subtitle,
  tabs,
  actions,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  tabs?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`shrink-0 border-b border-line ${className}`}>
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
        {/* The title must never collapse because a description shares its row. */}
        <h1 className="shrink-0 whitespace-nowrap text-xl font-bold text-navy">{title}</h1>
        {subtitle && (
          <span className="order-1 min-w-0 basis-full truncate text-[13px] text-muted sm:order-none sm:basis-auto sm:flex-1">
            {subtitle}
          </span>
        )}
        {actions && (
          <div className="order-2 flex basis-full shrink-0 items-center gap-2 sm:order-none sm:ml-auto sm:basis-auto">
            {actions}
          </div>
        )}
      </div>
      {tabs && <div className="flex items-center gap-1">{tabs}</div>}
    </div>
  );
}

/**
 * Screen workspace: a flex column that keeps the toolbar fixed and lets the
 * remaining region own the scroll (`min-height: 0`).
 */
export function Workspace({
  toolbar,
  children,
  className = "",
  bodyClassName = "",
  scroll = true,
}: {
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  scroll?: boolean;
}) {
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      {toolbar}
      <div
        className={`interview-workspace-body min-h-0 flex-1 pt-3 ${scroll ? "overflow-auto" : "flex flex-col"} ${bodyClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Bordered surface with an optional fixed header/footer and an internally
 * scrolling body. Pairs with `SplitPane` and `Workspace`.
 */
export function Panel({
  title,
  actions,
  footer,
  scroll = true,
  padded = true,
  className = "",
  bodyClassName = "",
  "data-testid": testId,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
  "data-testid"?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className={`flex min-h-0 flex-col rounded-[var(--radius-card)] border border-line bg-surface ${className}`}
    >
      {(title || actions) && (
        <header className="flex min-h-9 shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
          {title && (
            <h2 className="min-w-0 truncate text-sm font-semibold text-navy">{title}</h2>
          )}
          {actions && (
            <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div
        className={`min-h-0 flex-1 ${padded ? "p-3" : ""} ${scroll ? "overflow-auto" : ""} ${bodyClassName}`}
      >
        {children}
      </div>
      {footer && (
        <footer className="shrink-0 border-t border-line px-3 py-2">{footer}</footer>
      )}
    </section>
  );
}

/**
 * Two-pane layout. Panes scroll independently and may shrink (`min-width: 0`).
 * Stacks to one column below the `lg` breakpoint via `.interview-split`.
 */
export function SplitPane({
  left,
  right,
  leftWidth = 280,
  className = "",
}: {
  left: ReactNode;
  right: ReactNode;
  leftWidth?: number | string;
  className?: string;
}) {
  const width = typeof leftWidth === "number" ? `${leftWidth}px` : leftWidth;
  return (
    <div
      className={`interview-split min-h-0 ${className}`}
      style={{ ["--split-left" as string]: width }}
    >
      <div className="flex min-h-0 min-w-0 flex-col">{left}</div>
      <div className="flex min-h-0 min-w-0 flex-col">{right}</div>
    </div>
  );
}

/** Horizontal settings row: label + short description left, control right. */
export function SettingRow({
  label,
  description,
  control,
  className = "",
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-2 border-b border-line py-2.5 last:border-b-0 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-x-4 sm:gap-y-2 ${className}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {description && (
          <div className="mt-0.5 max-w-prose text-xs text-muted">{description}</div>
        )}
      </div>
      <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
        {control}
      </div>
    </div>
  );
}

/** A contiguous list row (compact, divider-separated). */
export function DataRow({
  leading,
  title,
  meta,
  trailing,
  selected = false,
  onClick,
  className = "",
  "data-testid": testId,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
  "data-testid"?: string;
}) {
  const cls = `flex w-full items-center gap-2.5 border-b border-line px-2.5 py-1.5 text-left last:border-b-0 ${
    selected ? "bg-tint" : "hover:bg-tint"
  } ${className}`;
  const inner = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{title}</span>
        {meta && <span className="mt-0.5 block truncate text-xs text-muted">{meta}</span>}
      </span>
      {trailing}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "true" : undefined}
        data-testid={testId}
        className={cls}
      >
        {inner}
      </button>
    );
  }
  return (
    <div aria-current={selected ? "true" : undefined} data-testid={testId} className={cls}>
      {inner}
    </div>
  );
}

/** Compact 72–96px summary strip of headline metrics. */
export function StatStrip({
  items,
  className = "",
}: {
  items: {
    label: ReactNode;
    value: ReactNode;
    suffix?: ReactNode;
    action?: ReactNode;
  }[];
  className?: string;
}) {
  return (
    <div
      className={`grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line sm:flex sm:flex-wrap sm:items-stretch sm:gap-0 sm:divide-x sm:divide-line ${className}`}
    >
      {items.map((item, i) => (
        <div key={i} className="min-w-0 flex-1 bg-surface px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            {item.label}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-lg font-semibold text-navy">
            {item.value}
            {item.suffix && <span className="text-xs text-muted">{item.suffix}</span>}
          </div>
          {item.action && <div className="mt-1 text-xs">{item.action}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Collapsible host container for extension (plugin) regions. Keeps plugin UI
 * compact, secondary, and out of the primary workspace until opened, with a
 * consistent heading/padding language across every slot.
 */
export function ExtensionRegion({
  title,
  hint,
  description,
  count,
  defaultOpen = false,
  className = "",
  "data-testid": testId,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  description?: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  className?: string;
  "data-testid"?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={`extension-region overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface ${className}`}
      data-testid={testId}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold text-navy"
      >
        <span
          aria-hidden
          className={`extension-caret text-muted ${open ? "is-open" : ""}`}
        >
          ▸
        </span>
        <span className="min-w-0 truncate">{title}</span>
        {count !== undefined && (
          <span className="text-xs font-normal text-muted">({count})</span>
        )}
        {hint && (
          <span className="ml-auto shrink-0 text-xs font-normal text-muted">{hint}</span>
        )}
      </button>
      {open && (
        <>
          {description && (
            <p className="px-3 pb-1 text-xs text-muted">{description}</p>
          )}
          <div className="border-t border-line p-3">{children}</div>
        </>
      )}
    </section>
  );
}
