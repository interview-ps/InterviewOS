import { taxonomy } from "@interview-os/frontend-types";
import type { UITone as Tone } from "@interview-os/frontend-types";

import { message } from "@/utils/antdMessage";
import { Pill } from "@/ui";
/* Interview OS product components (antd-backed) live in @/ui; pages import
   commodity UI (Button, Tabs, Input, Select, …) directly from antd. */
export {
  Badge,
  Bar,
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorNote,
  EvidenceList,
  InterviewEmptyState,
  InterviewQuestion,
  InterviewSpinner,
  PageHeader,
  Pill,
  QuestionCard,
  SkillGapBadge,
  SkillScoreCard,
  Skeleton,
  SkeletonCard,
  Spinner,
  Stat,
} from "@/ui";

/** Product alias — the component is `SkillScoreCard`. */
export { SkillScoreCard as SkillScore } from "@/ui";

/* Reusable product patterns. */
export {
  Callout,
  DeltaList,
  EvidenceTimeline,
  KeyValue,
  NextActionCard,
  PriorityList,
  ReadinessHero,
  SectionHeading,
  StatusBuckets,
  StatusDot,
  displayLabel,
  humanize,
  pct,
  readinessBarTone,
  readinessVerdict,
  trendOf,
} from "@/ui";
export type { Delta, EvidenceEntry, PriorityItem } from "@/ui";

/** Product charts (antd-free, shared with plugin frames). */
export { ReadinessChart, Sparkline } from "@interview-os/ui";

export type { Tone };

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
  return <Pill tone={tone}>{label}</Pill>;
}

/* -- non-blocking toasts (antd, theme-aware) ------------------------------- */

/** Fire-and-forget non-blocking toast backed by antd message. */
export function toast(text: string) {
  void message.success(text);
}

export function skillLabel(skillId: string, label?: string): string {
  if (label) return label;
  return taxonomy.labelFor(skillId as never);
}
