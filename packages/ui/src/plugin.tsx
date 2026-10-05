/**
 * Curated plugin UI surface — the stable contract third-party plugins build
 * against. It is intentionally SMALLER than the app design system and
 * **antd-free**: the host app uses Ant Design internally, plugins never see it.
 *
 * The same components are what the declarative `UINode` renderer maps to, so a
 * plugin composing these by hand and a plugin emitting a declarative tree look
 * identical.
 */
import type { ReactNode } from "react";

import {
  Badge,
  Bar,
  Button,
  Card,
  EmptyState,
  EvidenceList,
  InterviewQuestion,
  Skeleton,
  Spinner,
  Stat,
} from "./components.js";
import type { Tone } from "./components.js";

export { Badge, Bar, Button, Card, EmptyState, EvidenceList, InterviewQuestion, Skeleton, Spinner, Stat };
export type { Tone };
export { DeclarativeRenderer } from "./renderer.js";
export type { DeclarativeRendererProps } from "./renderer.js";

/* -- vocabulary + declarative schema -------------------------------------- */
export {
  UIToneSchema,
  UIActionSchema,
  UINodeSchema,
  APP_ROUTE_ALLOWLIST,
  UI_TREE_LIMITS,
  validateUITree,
} from "@interview-os/frontend-types";
export type { UITone, UIAction, UINode } from "@interview-os/frontend-types";

/* -- frame SDK (Level 2 plugin-authored components) ----------------------- */
export * from "./frame.js";

/* -- layout + typography (antd-free) --------------------------------------- */

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      {(title || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            {title && <h1 className="text-xl font-bold text-navy">{title}</h1>}
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card>
      {title && <h3 className="mb-2 text-base font-semibold text-navy">{title}</h3>}
      <div className="flex flex-col gap-3">{children}</div>
    </Card>
  );
}

const GAP = { sm: "gap-2", md: "gap-4", lg: "gap-6" } as const;

export function Stack({
  gap = "md",
  children,
}: {
  gap?: "sm" | "md" | "lg";
  children?: ReactNode;
}) {
  return <div className={`flex flex-col ${GAP[gap]}`}>{children}</div>;
}

export function Row({ children }: { children?: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-4">{children}</div>;
}

export function Heading({
  level = 2,
  children,
}: {
  level?: 1 | 2 | 3;
  children?: ReactNode;
}) {
  const cls =
    level === 1
      ? "text-xl font-bold text-navy"
      : level === 3
        ? "text-base font-semibold text-navy"
        : "text-lg font-semibold text-navy";
  return level === 1 ? <h1 className={cls}>{children}</h1> : level === 3 ? <h3 className={cls}>{children}</h3> : <h2 className={cls}>{children}</h2>;
}

const TEXT_TONE: Record<string, string> = {
  green: "text-green",
  amber: "text-accent",
  red: "text-danger",
  blue: "text-blue",
  muted: "text-muted",
};

export function Text({ tone, children }: { tone?: Tone; children?: ReactNode }) {
  return (
    <p className={`text-sm ${tone ? (TEXT_TONE[tone] ?? "text-ink") : "text-ink"}`}>
      {children}
    </p>
  );
}

/** Alias for {@link Badge} using the plugin-facing name. */
export const Tag = Badge;

/** Alias for {@link EmptyState} using the plugin-facing name. */
export const Empty = EmptyState;

/** Plain progress bar (alias for {@link Bar}). */
export const Progress = Bar;

export function Divider() {
  return <hr className="border-line" />;
}

export function Alert({
  tone = "amber",
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={`rounded-[0.6rem] border border-line p-3 text-sm ${TEXT_TONE[tone] ?? "text-ink"}`}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className="mt-1 text-muted">{children}</div>}
    </div>
  );
}
