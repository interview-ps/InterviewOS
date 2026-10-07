import { useCallback, useEffect, useState } from "react";
import { Popconfirm, Segmented, Select, Table } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { AIUsageBreakdown, AIUsageRecord } from "@interview-os/frontend-types";
import { api, type AIUsageSummary } from "@/lib/api";
import {
  Bar,
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  Pill,
  ScreenToolbar,
  Skeleton,
  StatStrip,
  Workspace,
  displayLabel,
} from "@/components/ui";
import { useAppRefreshEffect } from "@/lib/app-refresh";

const NOT_REPORTED = "not reported";

const fmtInt = (n: number) => n.toLocaleString();
const fmtCost = (amount: number, currency: string) => `${amount.toFixed(4)} ${currency}`;

type Range = "7d" | "30d" | "all";

/** ISO date for the start of a relative range (undefined = no lower bound). */
function rangeFrom(range: Range): string | undefined {
  if (range === "all") return undefined;
  const start = new Date();
  start.setDate(start.getDate() - (range === "7d" ? 7 : 30));
  return start.toISOString().slice(0, 10);
}

function monthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function tokensCell(input: number | null | undefined, output: number | null | undefined): string {
  if (input == null && output == null) return "—";
  return `${fmtInt(input ?? 0)} / ${fmtInt(output ?? 0)}`;
}

const costCell = (cost: { amount: number; currency: string }[]): string =>
  cost.length === 0 ? "—" : cost.map((c) => fmtCost(c.amount, c.currency)).join(" · ");

function breakdownColumns(firstTitle: string) {
  return [
    {
      title: firstTitle,
      key: "key",
      render: (_: unknown, entry: AIUsageBreakdown) =>
        entry.key === entry.label ? entry.label : displayLabel(entry.key),
    },
    {
      title: "Tokens (in/out)",
      key: "tokens",
      width: 160,
      render: (_: unknown, entry: AIUsageBreakdown) =>
        `${fmtInt(entry.inputTokens)} / ${fmtInt(entry.outputTokens)}`,
    },
    { title: "Turns", dataIndex: "turns", width: 80 },
    {
      title: "Cost",
      key: "cost",
      width: 140,
      render: (_: unknown, entry: AIUsageBreakdown) => costCell(entry.cost),
    },
  ];
}

const recentColumns = [
  {
    title: "When",
    dataIndex: "createdAt",
    width: 180,
    render: (value: string) => new Date(value).toLocaleString(),
  },
  {
    title: "Runtime",
    dataIndex: "runtimeKind",
    width: 110,
    render: (value: string) => <Pill tone="muted">{value}</Pill>,
  },
  {
    title: "Skill / task",
    key: "task",
    render: (_: unknown, row: AIUsageRecord) => (row.taskId ? displayLabel(row.taskId) : "—"),
  },
  {
    title: "Model",
    key: "model",
    width: 150,
    render: (_: unknown, row: AIUsageRecord) => row.model ?? "—",
  },
  {
    title: "Attempt",
    key: "attempt",
    width: 90,
    render: (_: unknown, row: AIUsageRecord) => (
      <span>
        {row.attempt ?? "—"}
        {row.ok === false ? (
          <Pill tone="amber">{row.errorCode ?? "failed"}</Pill>
        ) : null}
      </span>
    ),
  },
  {
    title: "Context",
    key: "context",
    width: 150,
    render: (_: unknown, row: AIUsageRecord) =>
      row.contextUsed != null && row.contextSize != null
        ? `${fmtInt(row.contextUsed)} / ${fmtInt(row.contextSize)}`
        : "—",
  },
  {
    title: "Tokens (in/out)",
    key: "tokens",
    width: 160,
    render: (_: unknown, row: AIUsageRecord) => tokensCell(row.inputTokens, row.outputTokens),
  },
  {
    title: "Cost",
    key: "cost",
    width: 130,
    render: (_: unknown, row: AIUsageRecord) =>
      row.costAmount != null && row.costCurrency ? fmtCost(row.costAmount, row.costCurrency) : "—",
  },
];

export default function Usage() {
  const [summary, setSummary] = useState<AIUsageSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [range, setRange] = useState<Range>("30d");
  const [runtime, setRuntime] = useState<string>("");
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [budget, setBudget] = useState<number | null>(null);
  const [monthCost, setMonthCost] = useState<number | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .aiUsage({ from: rangeFrom(range), runtime: runtime || undefined })
      .then((next) => {
        setSummary(next);
        // Keep the filter options stable from the unfiltered view.
        if (!runtime) setRuntimes(next.byRuntime.map((entry) => entry.key));
      })
      .catch(setError);
  }, [range, runtime]);

  useEffect(() => {
    load();
  }, [load]);
  useAppRefreshEffect(load);

  useEffect(() => {
    api
      .settings()
      .then((settings) => setBudget(settings.aiBudgetMonthly ?? null))
      .catch(() => setBudget(null));
  }, []);

  useEffect(() => {
    if (budget == null) {
      setMonthCost(null);
      return;
    }
    api
      .aiUsage({ from: monthStart() })
      .then((next) => {
        const usd = next.totals.cost.find((entry) => entry.currency === "USD");
        setMonthCost(usd ? usd.amount : 0);
      })
      .catch(() => setMonthCost(null));
  }, [budget, summary]);

  const onClear = () => {
    api
      .clearAiUsage()
      .then(() => load())
      .catch(setError);
  };

  const toolbar = (
    <ScreenToolbar
      title="AI Usage"
      subtitle="Token, context and cost usage reported by the active AI runtime. Numbers and ids only — prompts and answers are never stored."
      actions={
        <>
          <Segmented
            value={range}
            onChange={(value) => setRange(value as Range)}
            options={[
              { label: "7d", value: "7d" },
              { label: "30d", value: "30d" },
              { label: "All", value: "all" },
            ]}
          />
          <Select
            value={runtime || undefined}
            onChange={(value: string | undefined) => setRuntime(value ?? "")}
            allowClear
            placeholder="All runtimes"
            style={{ minWidth: 160 }}
            options={runtimes.map((kind) => ({ value: kind, label: kind }))}
          />
          <Button onClick={load} icon={<ReloadOutlined />}>
            Refresh
          </Button>
          <Popconfirm
            title="Clear all AI usage?"
            description="This deletes every recorded usage row. It cannot be undone."
            okText="Clear"
            okButtonProps={{ danger: true }}
            onConfirm={onClear}
          >
            <Button danger>Clear usage</Button>
          </Popconfirm>
        </>
      }
    />
  );

  if (!summary && !error) {
    return (
      <Workspace toolbar={toolbar} bodyClassName="space-y-3">
        <Skeleton className="h-40 w-full" />
      </Workspace>
    );
  }

  const totals = summary?.totals;
  const latest = summary?.latestContext ?? null;
  const hasUsage = (totals?.turns ?? 0) > 0;
  const tokensReported = totals?.tokensReported ?? false;
  const contextRatio = latest && latest.size > 0 ? latest.used / latest.size : 0;
  const tokenValue = (value: number) => (tokensReported ? fmtInt(value) : NOT_REPORTED);

  return (
    <Workspace toolbar={toolbar} bodyClassName="space-y-3">
      <ErrorNote error={error} />

      {budget != null && monthCost != null && monthCost > budget && (
        <p
          role="status"
          className="rounded-[var(--radius-card)] border border-[var(--color-accent)] bg-[var(--color-hover)] px-3.5 py-2 text-[13px] text-ink"
        >
          This month&apos;s AI cost ({fmtCost(monthCost, "USD")}) has passed the{" "}
          {fmtCost(budget, "USD")} budget set in Settings.
        </p>
      )}

      {!hasUsage && (
        <div className="mt-3 max-w-3xl">
          <Panel>
            <EmptyState
              title="No AI usage recorded yet"
              description="Nothing reported in this range. opencode, Devin, Codex and Claude report usage; run an analysis or an interview turn to generate records."
            />
          </Panel>
        </div>
      )}

      {hasUsage && totals && (
        <>
          <StatStrip
            items={[
              { label: "Input tokens", value: tokenValue(totals.inputTokens) },
              { label: "Output tokens", value: tokenValue(totals.outputTokens) },
              { label: "Total tokens", value: tokenValue(totals.totalTokens) },
              { label: "Turns", value: fmtInt(totals.turns) },
              ...totals.cost.map((entry) => ({
                label: `Cost (${entry.currency})`,
                value: entry.amount.toFixed(4),
              })),
            ]}
          />

          {!tokensReported && (
            <p className="text-xs text-muted">
              This runtime reports context and cost but not per-turn token counts.
            </p>
          )}

          <Panel title="Context window (latest session)">
            {latest ? (
              <div className="max-w-xl">
                <div className="flex items-baseline justify-between text-[13px]">
                  <span className="font-medium text-ink">
                    {fmtInt(latest.used)} of {fmtInt(latest.size)} tokens
                  </span>
                  <span className="text-muted">{Math.round(contextRatio * 100)}% used</span>
                </div>
                <div className="mt-1.5">
                  <Bar
                    value={contextRatio}
                    tone={contextRatio >= 0.9 ? "amber" : contextRatio >= 0.75 ? "blue" : "green"}
                  />
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {latest.runtimeKind}
                  {latest.providerSessionId ? ` · ${latest.providerSessionId}` : ""} ·{" "}
                  {new Date(latest.createdAt).toLocaleString()}
                </p>
              </div>
            ) : (
              <EmptyState
                title="No context size reported"
                description="This runtime does not report a context window size."
              />
            )}
          </Panel>

          <div className="grid gap-3 lg:grid-cols-3">
            <Panel title="By runtime" padded={false}>
              <Table
                size="small"
                rowKey="key"
                columns={breakdownColumns("Runtime")}
                dataSource={summary?.byRuntime ?? []}
                pagination={false}
              />
            </Panel>
            <Panel title="By skill / task" padded={false}>
              <Table
                size="small"
                rowKey="key"
                columns={breakdownColumns("Skill / task")}
                dataSource={summary?.bySkill ?? []}
                pagination={false}
              />
            </Panel>
            <Panel title="By model" padded={false}>
              <Table
                size="small"
                rowKey="key"
                columns={breakdownColumns("Model")}
                dataSource={summary?.byModel ?? []}
                pagination={false}
              />
            </Panel>
          </div>

          <Panel title="Recent turns" padded={false}>
            <Table
              size="small"
              rowKey="id"
              columns={recentColumns}
              dataSource={summary?.recent ?? []}
              pagination={false}
            />
          </Panel>
        </>
      )}
    </Workspace>
  );
}
