import type { ReactNode } from "react";

import { TargetBar, isLowConfidence } from "./charts.js";

/**
 * Evidence timeline — antd-free. Evidence ids are the core invariant behind
 * every readiness score, so this surface makes them visible: each node shows
 * what kind of evidence it is, the score, the confidence (kept distinct from
 * the score), the observation, and the evidence id itself.
 */

export type EvidenceTypeLike =
  | "resume_claim"
  | "interview_answer"
  | "practice"
  | "self_report"
  | "plugin";

export interface EvidenceItem {
  id: string;
  skillId: string;
  type: string;
  score: number;
  confidence: number;
  observation: string;
  source?: string | null;
  sessionId?: string | null;
  createdAt: string;
}

export type EvidenceTone = "blue" | "green" | "amber" | "muted";

export function evidenceTypeTone(type: string): EvidenceTone {
  if (type === "interview_answer") return "blue";
  if (type === "practice") return "green";
  if (type === "plugin") return "amber";
  return "muted";
}

export function evidenceTypeLabel(type: string): string {
  switch (type) {
    case "interview_answer":
      return "Interview answer";
    case "practice":
      return "Practice";
    case "plugin":
      return "Extension";
    case "resume_claim":
      return "Resume";
    case "self_report":
      return "Self report";
    default:
      return type
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

const TONE_CHIP: Record<EvidenceTone, string> = {
  blue: "bg-[var(--color-tint)] text-[var(--color-blue-hover)]",
  green: "bg-[var(--color-green-tint)] text-[var(--color-green)]",
  amber: "bg-[var(--color-accent-tint)] text-[var(--color-accent)]",
  muted: "bg-[var(--color-neutral-tint)] text-[var(--color-neutral)]",
};

export function EvidenceTypeChip({ type }: { type: string }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-[var(--radius-xs)] px-1.5 text-[11px] font-medium leading-none ${TONE_CHIP[evidenceTypeTone(type)]}`}
    >
      {evidenceTypeLabel(type)}
    </span>
  );
}

function isPluginSource(source: string | null | undefined): boolean {
  return typeof source === "string" && source.startsWith("plugin:");
}

export function EvidenceTimeline({
  items,
  limit,
  showSkill = false,
  empty = "No evidence recorded for this skill yet.",
}: {
  items: EvidenceItem[];
  limit?: number;
  showSkill?: boolean;
  empty?: ReactNode;
}) {
  const rows = limit ? items.slice(0, limit) : items;
  if (rows.length === 0) {
    return <p className="text-sm text-muted">{empty}</p>;
  }
  return (
    <ol className="relative space-y-3 ps-4">
      <span
        aria-hidden
        className="absolute inset-y-1 start-[3px] w-px bg-[var(--color-divider)]"
      />
      {rows.map((item) => (
        <li key={item.id} className="relative">
          <span
            aria-hidden
            className="absolute -start-4 top-3 h-1.5 w-1.5 rounded-full bg-[var(--color-blue)]"
          />
          <div className="rounded-[var(--radius-sm)] border border-divider bg-surface p-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <EvidenceTypeChip type={item.type} />
              {showSkill && (
                <span className="rounded-[var(--radius-xs)] bg-[var(--color-inset)] px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {item.skillId}
                </span>
              )}
              <span className="text-[13px] font-medium tabular-nums text-navy">
                {Math.round(item.score * 100)}%
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-10">
                  <TargetBar
                    value={item.confidence}
                    tone={
                      isLowConfidence(item.confidence)
                        ? "var(--color-accent)"
                        : "var(--color-blue)"
                    }
                  />
                </span>
                <span className="text-[11px] tabular-nums text-muted">
                  confidence {Math.round(item.confidence * 100)}%
                </span>
              </span>
              <span className="ms-auto text-[11px] text-muted">
                {new Date(item.createdAt).toLocaleDateString()}
              </span>
            </div>
            {item.observation && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-ink">
                {item.observation}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code
                data-testid="evidence-id"
                className="rounded-[var(--radius-xs)] bg-[var(--color-inset)] px-1.5 py-0.5 font-mono text-[11px] text-muted"
              >
                {item.id}
              </code>
              {isPluginSource(item.source) && (
                <span className="rounded-[var(--radius-xs)] bg-[var(--color-accent-tint)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent)]">
                  {item.source}
                </span>
              )}
              {item.sessionId && (
                <a
                  href={`/interview/${item.sessionId}`}
                  className="text-[11px] text-blue underline"
                >
                  view session
                </a>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
