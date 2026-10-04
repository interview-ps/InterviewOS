import { useEffect, useState } from "react";
import { taxonomy } from "@interview-os/core";
import { Pill, type Tone } from "@interview-os/ui";

/* -- design system lives in @interview-os/ui; re-exported here so existing
   page imports (`@/components/ui`) keep working --------------------------- */
export {
  Badge,
  Bar,
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorNote,
  EvidenceList,
  InterviewQuestion,
  PageHeader,
  Pill,
  ReadinessChart,
  Skeleton,
  SkeletonCard,
  SkillScore,
  Sparkline,
  Spinner,
  Stat,
  Tabs,
  theme,
} from "@interview-os/ui";
export type { Tone } from "@interview-os/ui";

/* -- consistent tone mapping (app-specific) -------------------------------- */

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

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === "strong" ? "green"
    : status === "developing" ? "blue"
    : status === "weak" ? "amber"
    : "muted";
  const label = status === "unknown" ? "not yet assessed" : status;
  return <Pill tone={tone as "green"}>{label}</Pill>;
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

export function skillLabel(skillId: string, label?: string): string {
  if (label) return label;
  return taxonomy.labelFor(skillId as never);
}
