import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Table, type TableColumnsType } from "antd";
import {
  api,
  type AppState,
  type CompanyProfileInfo,
  type Gap,
  type SetupResult,
  type TargetListItem,
  type WorkspaceSources,
} from "@/lib/api";
import {
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  Pill,
  PriorityList,
  ScreenToolbar,
  skillLabel,
  Spinner,
  Workspace,
} from "@/components/ui";
import { SetupForm } from "@/components/setup-form";
import { ExtensionSlot } from "@/components/plugin-ui";
import { useAppRefresh, useAppRefreshEffect } from "@/lib/app-refresh";

type TabKey = "overview" | "sources" | "requirements";

function TargetsPanel({
  targets,
  onSwitch,
}: {
  targets: TargetListItem[];
  onSwitch: (id: string) => void;
}) {
  if (targets.length === 0) return null;
  return (
    <Panel title="Your targets" padded={false} className="shrink-0">
      <ul>
        {targets.map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 last:border-b-0"
          >
            <span className="min-w-0 truncate text-[13px]">
              <span className="font-medium text-ink">{t.role}</span>
              <span className="text-muted"> — {t.company}</span>
              <span className="ml-1 text-xs text-muted">({t.level})</span>
            </span>
            {t.active ? (
              <Pill tone="green">active</Pill>
            ) : (
              <Button variant="secondary" size="small" onClick={() => onSwitch(t.id)}>
                Switch
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function CompanyProfile({ activeTarget, profiles }: { activeTarget: TargetListItem; profiles: CompanyProfileInfo[] }) {
  const [open, setOpen] = useState(false);
  const info =
    profiles.find((p) => p.id === activeTarget.companyProfileId) ??
    profiles.find((p) => p.id === "generic") ??
    null;
  const profile = activeTarget.companyProfile;
  return (
    <div data-testid="company-profile">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer text-[13px] font-medium text-navy"
      >
        {open ? "▾" : "▸"} Company interview style
      </button>
      {open && (
        <div className="mt-2 text-xs text-muted">
          <label className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-navy">Company profile</span>
            <select
              aria-label="Company profile"
              value={info?.id ?? "generic"}
              onChange={(e) => api.updateTargetProfile(activeTarget.id, e.target.value)}
              className="rounded-[var(--radius-sm)] border border-line bg-surface px-2 py-1 text-[13px]"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {info && (
            <div className="mt-1">
              <p>
                Typical loop: {info.typicalLoop.map((s) => s.label).join(" → ")} · follow-up depth{" "}
                {info.followUpDepth}
              </p>
              {info.behavioralFramework && (
                <p className="mt-0.5">
                  {info.behavioralFramework.name}: {info.behavioralFramework.themes.join(", ")}
                </p>
              )}
              <p className="mt-1 italic">{info.disclaimer}</p>
            </div>
          )}
          {profile?.interviewStyle && (
            <p className="mt-1">
              <span className="text-ink">Interview style:</span> {profile.interviewStyle}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function TargetRole() {
  const refresh = useAppRefresh();
  const [targets, setTargets] = useState<TargetListItem[]>([]);
  const [profiles, setProfiles] = useState<CompanyProfileInfo[]>([]);
  const [state, setState] = useState<AppState | null>(null);
  const [sources, setSources] = useState<WorkspaceSources | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<TabKey>(
    typeof window !== "undefined" && window.location.hash === "#requirements"
      ? "requirements"
      : "sources",
  );
  const hasCandidate = targets.length > 0;

  const loadTargets = useCallback(() => {
    api.listTargets().then(setTargets).catch(() => setTargets([]));
  }, []);

  const loadState = useCallback(() => {
    api.state().then(setState).catch(() => {});
  }, []);

  const loadSources = useCallback(() => {
    api.workspaceSources().then(setSources).catch(() => setSources(null));
  }, []);

  useEffect(() => {
    api.companies().then(setProfiles).catch(() => setProfiles([]));
    loadTargets();
    loadState();
    loadSources();
  }, [loadTargets, loadState, loadSources]);
  useAppRefreshEffect(() => {
    loadTargets();
    loadState();
    loadSources();
  });

  const activeTarget = targets.find((t) => t.active);

  // Prefer the fresh analyze result; fall back to persisted state on reload.
  const requirements = result?.target.requirements ?? state?.target.requirements ?? [];
  const preferredSkills = result?.target.preferredSkills ?? state?.target.preferredSkills ?? [];
  const gaps = useMemo<Gap[]>(
    () => result?.gaps ?? state?.assessment.gaps ?? [],
    [result, state],
  );
  const dimensions = state?.readiness.dimensions ?? {};
  const candidateSkills = result?.candidate.skills ?? state?.candidate.skills ?? [];
  const gapBySkill = useMemo(() => new Map(gaps.map((g) => [g.skillId, g])), [gaps]);

  const allRequirements = useMemo(
    () =>
      [...requirements, ...preferredSkills].sort((a, b) => b.importance - a.importance),
    [requirements, preferredSkills],
  );

  const scoreOf = (r: (typeof allRequirements)[number]) =>
    gapBySkill.get(r.skillId)?.currentScore ?? dimensions[r.skillId]?.score ?? null;

  const columns: TableColumnsType<(typeof allRequirements)[number]> = [
    {
      title: "Skill",
      dataIndex: "label",
      render: (_: unknown, r: (typeof allRequirements)[number]) => (
        <span className="font-medium text-ink">{r.label || skillLabel(r.skillId)}</span>
      ),
    },
    {
      title: "Type",
      dataIndex: "kind",
      width: 96,
      responsive: ["md"],
      filters: [
        { text: "Required", value: "required" },
        { text: "Preferred", value: "preferred" },
      ],
      onFilter: (value, r: (typeof allRequirements)[number]) => r.kind === value,
      render: (kind: string) => (
        <Pill tone={kind === "required" ? "blue" : "muted"}>{kind}</Pill>
      ),
    },
    {
      title: "Role importance",
      dataIndex: "importance",
      width: 130,
      sorter: (
        a: (typeof allRequirements)[number],
        b: (typeof allRequirements)[number],
      ) => a.importance - b.importance,
      render: (importance: number) => (
        <span className="text-xs text-muted">{Math.round(importance * 100)}%</span>
      ),
    },
    {
      title: "Evidence & readiness",
      key: "readiness",
      sorter: (
        a: (typeof allRequirements)[number],
        b: (typeof allRequirements)[number],
      ) => (scoreOf(a) ?? -1) - (scoreOf(b) ?? -1),
      render: (_: unknown, r: (typeof allRequirements)[number]) => {
        const g = gapBySkill.get(r.skillId);
        const dim = dimensions[r.skillId];
        const score = scoreOf(r);
        if (score === null || score === undefined) {
          return (
            <span className="text-xs text-muted">
              {r.evidence ? "resume only — not assessed" : "no evidence yet — not assessed"}
            </span>
          );
        }
        const weak = g ? g.gap > 0 : false;
        return (
          <span className="text-xs">
            {Math.round(score * 100)}%
            <span className="ml-1 text-muted">
              {weak ? "below target" : "meets target"}
            </span>
            {dim?.evidenceIds?.length ? (
              <span className="ml-1 text-muted">· {dim.evidenceIds.length} evidence</span>
            ) : null}
          </span>
        );
      },
    },
    {
      title: "Preparation priority",
      key: "priority",
      width: 150,
      responsive: ["md"],
      render: (_: unknown, r: (typeof allRequirements)[number]) => {
        const g = gapBySkill.get(r.skillId);
        if (!g) return <span className="text-xs text-muted">not assessed</span>;
        return (
          <Pill
            tone={g.severity === "high" ? "amber" : g.severity === "medium" ? "blue" : "muted"}
          >
            {g.severity}
          </Pill>
        );
      },
    },
  ];

  return (
    <Workspace
      toolbar={
        <ScreenToolbar
          title="Target"
          subtitle={
            activeTarget
              ? `${activeTarget.role} · ${activeTarget.company} · ${activeTarget.level}`
              : "Define the role and the resume you're preparing with."
          }
          tabs={
            <div className="flex items-center gap-1">
              {(
                [
                  ["overview", "Overview"],
                  ["sources", "Sources"],
                  ["requirements", "Requirements"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-current={tab === key ? "page" : undefined}
                  onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 px-2.5 py-1.5 text-[13px] ${
                    tab === key
                      ? "border-blue font-semibold text-navy"
                      : "border-transparent text-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
          actions={
            gaps.length > 0 ? (
              <Link to="/prepare">
                <Button size="small">Build preparation plan</Button>
              </Link>
            ) : undefined
          }
        />
      }
    >
      <ErrorNote error={error} />

      {tab === "overview" && (
        <div className="max-w-4xl space-y-3">
          {activeTarget && (
            <CompanyProfile activeTarget={activeTarget} profiles={profiles} />
          )}
          <TargetsPanel
            targets={targets}
            onSwitch={(id) =>
              api
                .activateTarget(id)
                .then(() => {
                  loadTargets();
                  loadState();
                  refresh();
                })
                .catch(setError)
            }
          />

          {gaps.length > 0 ? (
            <Panel title="Identified gaps">
              <PriorityList
                empty="No gaps detected — nice."
                items={gaps.map((g) => ({
                  key: g.skillId,
                  label: g.label || skillLabel(g.skillId),
                  statusLabel: g.severity,
                  tone: g.severity === "high" ? "amber" : g.severity === "medium" ? "blue" : "muted",
                  readiness: g.currentScore,
                  note: g.reason,
                }))}
              />
            </Panel>
          ) : (
            <Panel title="Identified gaps">
              <EmptyState
                title="No analysis yet"
                description="Add your resume and the job description on the Sources tab, then analyze."
                action={
                  <Button variant="secondary" size="small" onClick={() => setTab("sources")}>
                    Open sources
                  </Button>
                }
              />
            </Panel>
          )}

          {candidateSkills.length > 0 && (
            <Panel title="Candidate skills" padded={false}>
              <ul>
                {candidateSkills.map((s) => (
                  <li
                    key={s.skillId}
                    className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-[13px] last:border-b-0"
                  >
                    <span className="min-w-0 truncate">{skillLabel(s.skillId)}</span>
                    <span className="text-xs text-muted">level {Math.round(s.level * 100)}%</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <ExtensionSlot slot="target.tabs" />
        </div>
      )}

      {tab === "sources" && (
        <div className="max-w-4xl space-y-3" id="add-target">
          <Panel>
            {hasCandidate ? (
              <>
                <p className="mb-2 text-xs text-muted">
                  These are your saved sources. Editing them and running Analyze replaces your
                  current analysis and preparation plan.
                </p>
                {sources ? (
                  <SetupForm
                    key="saved-sources"
                    mode="workspace"
                    title="Resume & job description"
                    initialValues={{ ...sources, companyNotes: sources.companyNotes ?? "" }}
                    onDone={(r) => {
                      if (r) {
                        setResult(r);
                        setTab("overview");
                      }
                      loadTargets();
                      loadState();
                      loadSources();
                    }}
                  />
                ) : (
                  <Spinner label="Loading saved sources…" />
                )}
                <div className="mt-3 border-t border-line pt-2">
                  <button
                    type="button"
                    aria-expanded={showAdd}
                    onClick={() => setShowAdd((v) => !v)}
                    className="cursor-pointer text-[13px] font-medium text-navy"
                  >
                    {showAdd ? "▾" : "▸"} Add another target role
                  </button>
                  {showAdd && (
                    <div className="mt-2">
                      <SetupForm
                        mode="target"
                        onDone={() => {
                          loadTargets();
                          loadState();
                          refresh();
                        }}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <SetupForm
                mode="workspace"
                title="Set up your workspace"
                showSteps
                onDone={(r) => {
                  if (r) {
                    setResult(r);
                    setTab("overview");
                  }
                  loadTargets();
                  loadState();
                }}
              />
            )}
          </Panel>
        </div>
      )}

      {tab === "requirements" && (
        <Panel
          title={`${requirements.length + preferredSkills.length} skills for this role`}
          padded={false}
        >
          {allRequirements.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No requirements yet"
                description="Analyze a target to extract its requirements."
                action={
                  <Button variant="secondary" size="small" onClick={() => setTab("sources")}>
                    Open sources
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <p className="border-b border-line px-3 py-2 text-xs text-muted">
                <strong>Role importance</strong> is how much the role weights this skill — not your
                performance. <strong>Readiness</strong> comes from your evidence (resume claims and
                interview answers); <strong>Preparation priority</strong> is derived from importance ×
                gap and can differ from the readiness label.
              </p>
              <Table
                size="small"
                rowKey="skillId"
                columns={columns}
                dataSource={allRequirements}
                pagination={false}
                scroll={{ x: "max-content" }}
                expandable={{
                  expandRowByClick: true,
                  expandedRowRender: (r: (typeof allRequirements)[number]) => {
                    const g = gapBySkill.get(r.skillId);
                    return (
                      <div className="space-y-1 text-xs text-muted">
                        <p className="font-medium text-ink">
                          {r.label || skillLabel(r.skillId)}
                        </p>
                        {r.evidence ? (
                          <p>
                            <span className="font-medium text-ink">Resume evidence:</span> “
                            {r.evidence}”
                          </p>
                        ) : (
                          <p>No resume evidence for this skill.</p>
                        )}
                        {g && (
                          <p>
                            <span className="font-medium text-ink">Readiness gap:</span> {g.reason}{" "}
                            (current{" "}
                            {g.currentScore === null
                              ? "not assessed"
                              : `${Math.round(g.currentScore * 100)}%`}
                            , target {Math.round(g.targetScore * 100)}%)
                          </p>
                        )}
                      </div>
                    );
                  },
                }}
              />
            </>
          )}
        </Panel>
      )}
    </Workspace>
  );
}
