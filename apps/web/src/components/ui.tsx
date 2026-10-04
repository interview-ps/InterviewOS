import { useEffect, useState, type ReactNode } from "react";
import { taxonomy } from "@interview-os/core";
import { ApiError } from "@/lib/api";

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

/* -- non-blocking toasts --------------------------------------------------- */

type ToastMsg = { id: number; message: string };
let toastSeq = 0;
const toastListeners = new Set<(t: ToastMsg) => void>();

/** Fire-and-forget non-blocking toast. */
export function toast(message: string) {
  const t = { id: ++toastSeq, message };
  for (const l of toastListeners) l(t);
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  useEffect(() => {
    const push = (t: ToastMsg) => {
      setToasts((prev) => [...prev, t]);
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 3500);
    };
    toastListeners.add(push);
    return () => {
      toastListeners.delete(push);
    };
  }, []);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto rounded-[0.6rem] border border-line bg-navy px-4 py-2 text-sm text-white shadow-md"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

/* -- consistent tone mapping ---------------------------------------------- */

export type Tone = "green" | "amber" | "red" | "blue" | "muted";

/** Severity → pill tone. */
export function severityTone(severity: string): Tone {
  if (severity === "high") return "red";
  if (severity === "medium") return "amber";
  return "muted";
}

/** Interview signal → pill tone. */
export function signalTone(signal: string): Tone {
  if (signal === "strong") return "green";
  if (signal === "mixed") return "amber";
  if (signal === "weak") return "red";
  return "muted";
}

/** Session/loop/status → pill tone. */
export function statusTone(status: string): Tone {
  if (status === "complete" || status === "strong" || status === "active") return "green";
  if (status === "in_progress" || status === "running" || status === "developing") return "blue";
  if (status === "weak" || status === "error") return "amber";
  return "muted";
}

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
      className={`rounded-[1rem] border border-line bg-surface p-5 shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-lg font-semibold text-navy">{children}</h2>;
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

export function Pill({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  const styles = {
    green: "bg-green-tint text-green",
    amber: "bg-[#fdf3e7] text-accent",
    red: "bg-[#fdeef2] text-danger",
    blue: "bg-tint text-blue",
    muted: "bg-page text-muted",
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === "strong" ? "green"
    : status === "developing" ? "blue"
    : status === "weak" ? "amber"
    : "muted";
  const label = status === "unknown" ? "not yet assessed" : status;
  return <Pill tone={tone as "green"}>{label}</Pill>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const status = error instanceof ApiError ? error.status : undefined;
  const code = error instanceof ApiError ? error.code : undefined;
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
      className={`rounded-[0.6rem] px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles}`}
    >
      {children}
    </button>
  );
}

export function skillLabel(skillId: string, label?: string): string {
  if (label) return label;
  return taxonomy.labelFor(skillId as never);
}
