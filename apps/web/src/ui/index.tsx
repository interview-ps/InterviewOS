import type { ReactNode } from "react";
import {
  Alert,
  Button as AntButton,
  Card as AntCard,
  Empty,
  List,
  Progress,
  Skeleton as AntSkeleton,
  Spin,
  Statistic,
  Tag,
  Typography,
} from "antd";
import type { ButtonProps as AntButtonProps } from "antd";
import type { UITone as Tone } from "@interview-os/frontend-types";

/* -- emphasis vocabulary --------------------------------------------------- */

/**
 * The ONE wrapper over an antd primitive, and deliberately so: it carries the
 * Interview OS emphasis vocabulary (`variant`) that product code and plugin
 * authors already speak, and sets the product default emphasis (primary).
 * Every other commodity primitive is used directly from antd.
 */
export function Button({
  variant = "primary",
  type = "button",
  children,
  ...rest
}: {
  variant?: "primary" | "secondary" | "ghost";
  type?: "button" | "submit";
} & Omit<AntButtonProps, "type" | "htmlType" | "variant">) {
  const antType =
    variant === "primary" ? "primary" : variant === "secondary" ? "default" : "text";
  return (
    <AntButton type={antType} htmlType={type === "submit" ? "submit" : "button"} {...rest}>
      {children}
    </AntButton>
  );
}

/* -- tone vocabulary ------------------------------------------------------- */

const TAG_COLOR: Record<Tone, string> = {
  green: "success",
  amber: "warning",
  red: "error",
  blue: "processing",
  muted: "default",
};

/** Product tag: the Interview OS tone vocabulary over antd Tag. */
export function Pill({
  tone = "muted",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <Tag color={TAG_COLOR[tone]} style={{ marginInlineEnd: 0 }}>
      {children}
    </Tag>
  );
}

/** Back-compat name — the vocabulary is `Pill`. */
export const Badge = Pill;

export function SkillGapBadge({ severity }: { severity: string }) {
  const tone: Tone =
    severity === "high" ? "amber" : severity === "medium" ? "blue" : "muted";
  return <Pill tone={tone}>{severity}</Pill>;
}

/* -- page furniture -------------------------------------------------------- */

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
    <div className="interview-page-header flex flex-wrap items-end justify-between gap-3">
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {subtitle && (
          <Typography.Text type="secondary">{subtitle}</Typography.Text>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Product surface: an antd Card with the Interview OS radius/shadow language. */
export function Card({
  children,
  className = "",
  id,
  title,
  extra,
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  title?: ReactNode;
  extra?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section id={id} data-testid={testId} className={className}>
      <AntCard
        className="interview-card"
        title={title}
        extra={extra}
        styles={{ body: { padding: 20 } }}
      >
        {children}
      </AntCard>
    </section>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return (
    <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
      {children}
    </Typography.Title>
  );
}

/* -- progress / stats ------------------------------------------------------ */

const BAR_COLOR: Record<string, string> = {
  blue: "var(--interview-brand)",
  green: "var(--interview-success)",
  amber: "var(--interview-warning)",
  muted: "var(--interview-border)",
};

export function Bar({
  value,
  tone = "blue",
}: {
  value: number;
  tone?: "blue" | "green" | "amber" | "muted";
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <Progress
        percent={pct}
        showInfo={false}
        size="small"
        strokeColor={BAR_COLOR[tone]}
      />
    </div>
  );
}

export function Stat({
  label,
  value,
  trend,
}: {
  label: ReactNode;
  value: ReactNode;
  trend?: "up" | "down" | "flat";
  tone?: Tone;
}) {
  const suffix =
    trend === "up" ? "↑" : trend === "down" ? "↓" : trend === "flat" ? "→" : undefined;
  return (
    <Statistic
      title={label}
      value={value as string | number}
      suffix={suffix}
      valueStyle={{ fontSize: 20, fontWeight: 600 }}
    />
  );
}

export function SkillScoreCard({
  label,
  score,
  confidence,
}: {
  label: ReactNode;
  score: number | null;
  confidence?: number;
}) {
  return (
    <div className="interview-skill-score">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <Typography.Text strong>{label}</Typography.Text>
        <Typography.Text type="secondary">
          {score === null ? "not assessed" : `${Math.round(score * 100)}%`}
        </Typography.Text>
      </div>
      <Bar
        value={score ?? 0}
        tone={
          score === null
            ? "muted"
            : score >= 0.6
              ? "green"
              : score >= 0.35
                ? "blue"
                : "amber"
        }
      />
      {confidence !== undefined && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          confidence {Math.round(confidence * 100)}%
        </Typography.Text>
      )}
    </div>
  );
}

/* -- overlays / states ----------------------------------------------------- */

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
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <div>
          <Typography.Text strong>{title}</Typography.Text>
          {description && (
            <div>
              <Typography.Text type="secondary">{description}</Typography.Text>
            </div>
          )}
        </div>
      }
    >
      {action}
    </Empty>
  );
}

/** Product empty state used app-wide. */
export const InterviewEmptyState = EmptyState;

export function Spinner({ label = "Working…" }: { label?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 text-sm"
    >
      <Spin size="small" />
      <Typography.Text type="secondary">{label}</Typography.Text>
    </span>
  );
}

export const InterviewSpinner = Spinner;

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <AntSkeleton.Input active block className={className} style={{ minHeight: 16 }} />
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <Card>
      <AntSkeleton active title paragraph={{ rows: lines }} />
    </Card>
  );
}

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
  const heading = isTimeout
    ? "The AI runtime timed out"
    : isRuntimeFailure
      ? "The AI runtime failed"
      : isUnavailable
        ? "The AI runtime is unavailable"
        : "Something went wrong";
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      message={heading}
      description={
        <div>
          <div>{error instanceof Error ? error.message : String(error)}</div>
          {(isUnavailable || isRuntimeFailure || isTimeout) && (
            <div className="mt-2">
              Check the active runtime under{" "}
              <a href="/settings">Settings</a>, then retry.
            </div>
          )}
        </div>
      }
    />
  );
}

/* -- product data display -------------------------------------------------- */

export function QuestionCard({
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
    <Card className="interview-question-card">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {skill && <Pill tone="blue">{skill}</Pill>}
        {difficulty && <Pill tone="muted">{difficulty}</Pill>}
        {source && (
          <>
            <Pill tone="muted">{source.label}</Pill>
            {source.community && <Pill tone="amber">community</Pill>}
          </>
        )}
      </div>
      <Typography.Text style={{ fontSize: 16 }}>{text}</Typography.Text>
    </Card>
  );
}

/** Product alias kept for existing imports. */
export const InterviewQuestion = QuestionCard;

export function EvidenceList({
  items,
}: {
  items: {
    skillId: string;
    observation: string;
    score?: number;
    createdAt?: string;
  }[];
}) {
  if (items.length === 0) {
    return <Typography.Text type="secondary">No evidence yet.</Typography.Text>;
  }
  return (
    <List
      size="small"
      dataSource={items}
      renderItem={(e) => (
        <List.Item>
          <div className="w-full text-sm">
            <div className="flex items-center justify-between gap-2">
              <Typography.Text strong>{e.skillId}</Typography.Text>
              {e.score !== undefined && (
                <Pill
                  tone={e.score >= 0.6 ? "green" : e.score >= 0.4 ? "amber" : "red"}
                >
                  {Math.round(e.score * 100)}%
                </Pill>
              )}
            </div>
            <div>{e.observation}</div>
            {e.createdAt && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {e.createdAt.slice(0, 10)}
              </Typography.Text>
            )}
          </div>
        </List.Item>
      )}
    />
  );
}
