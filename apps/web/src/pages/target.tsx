import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Table } from "antd";
import {
  api,
  type AppState,
  type CompanyProfileInfo,
  type Gap,
  type SetupResult,
  type TargetListItem,
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
  Workspace,
} from "@/components/ui";
import { SetupForm } from "@/components/setup-form";
import { PluginSlot } from "@/components/plugin-ui";
import { useAppRefresh } from "@/lib/app-refresh";

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

  useEffect(() => {
    api.companies().then(setProfiles).catch(() => setProfiles([]));
    loadTargets();
    loadState();
  }, [loadTargets, loadState]);

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

  const columns = [
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
      render: (kind: string) => (
        <Pill tone={kind === "required" ? "blue" : "muted"}>{kind}</Pill>
      ),
    },
    {
      title: "Importance",
      dataIndex: "importance",
      width: 110,
      render: (importance: number) => (
        <span className="text-xs text-muted">{Math.round(importance * 100)}%</span>
      ),
    },
    {
      title: "Evidence & readiness",
      key: "readiness",
      render: (_: unknown, r: (typeof allRequirements)[number]) => {
        const g = gapBySkill.get(r.skillId);
        const dim = dimensions[r.skillId];
        const score = g?.currentScore ?? dim?.score ?? null;
        if (score === null || score === undefined) {
          return <span className="text-xs text-muted">no evidence yet — not assessed</span>;
        }
        const weak = g ? g.gap > 0 : false;
        return (
          <span className="text-xs">
            {Math.round(score * 100)}%
            <span className="ml-1 text-muted">
              {weak ? "below target" : "meets target"}
            </span>
          </span>
        );
      },
    },
    {
      title: "Prep priority",
      key: "priority",
      width: 120,
      render: (_: unknown, r: (typeof allRequirements)[number]) => {
        const g = gapBySkill.get(r.skillId);
        if (!g) return <span className="text-xs text-muted">—</span>;
        return <Pill tone={g.severity === "high" ? "amber" : g.severity === "medium" ? "blue" : "muted"}>{g.severity}</Pill>;
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

          <PluginSlot slot="target.tabs" />
        </div>
      )}

      {tab === "sources" && (
        <div className="max-w-4xl space-y-3" id="add-target">
          <Panel>
            {hasCandidate ? (
              <>
                <SetupForm
                  mode="workspace"
                  title="Resume & job description"
                  onDone={(r) => {
                    if (r) {
                      setResult(r);
                      setTab("overview");
                    }
                    loadTargets();
                    loadState();
                  }}
                />
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
            <Table
              size="small"
              rowKey="skillId"
              columns={columns}
              dataSource={allRequirements}
              pagination={false}
              expandable={{
                expandedRowRender: (r: (typeof allRequirements)[number]) => {
                  const g = gapBySkill.get(r.skillId);
                  return (
                    <div className="space-y-1 text-xs text-muted">
                      {r.evidence ? (
                        <p>
                          <span className="font-medium text-ink">Evidence:</span> “{r.evidence}”
                        </p>
                      ) : (
                        <p>No resume evidence for this skill.</p>
                      )}
                      {g && (
                        <p>
                          <span className="font-medium text-ink">Gap:</span> {g.reason} (current{" "}
                          {g.currentScore === null ? "—" : `${Math.round(g.currentScore * 100)}%`},
                          target {Math.round(g.targetScore * 100)}%)
                        </p>
                      )}
                    </div>
                  );
                },
              }}
            />
          )}
        </Panel>
      )}
    </Workspace>
  );
}
