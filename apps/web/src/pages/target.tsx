import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  api,
  type CompanyProfileInfo,
  type SetupResult,
  type TargetListItem,
} from "@/lib/api";
import {
  Button,
  Callout,
  Card,
  CardTitle,
  ErrorNote,
  PageHeader,
  Pill,
  PriorityList,
  SectionHeading,
  skillLabel,
} from "@/components/ui";
import { SetupForm } from "@/components/setup-form";
import { PluginSlot } from "@/components/plugin-ui";
import { useAppRefresh } from "@/lib/app-refresh";

export default function TargetRole() {
  const refresh = useAppRefresh();
  const [targets, setTargets] = useState<TargetListItem[]>([]);
  const [profiles, setProfiles] = useState<CompanyProfileInfo[]>([]);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const hasCandidate = targets.length > 0;

  const loadTargets = useCallback(() => {
    api.listTargets().then(setTargets).catch(() => setTargets([]));
  }, []);

  useEffect(() => {
    api.companies().then(setProfiles).catch(() => setProfiles([]));
    loadTargets();
  }, [loadTargets]);

  const activeTarget = targets.find((t) => t.active);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Target role"
        subtitle="Define the mission: the role, the company, and the resume you are preparing with."
      />
      <ErrorNote error={error} />

      {hasCandidate && (
        <Card>
          <SectionHeading
            title="Your targets"
            description="Switch between the roles you are preparing for."
          />
          <ul className="space-y-1.5 text-sm">
            {targets.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2">
                <span>
                  {t.role} — {t.company}{" "}
                  <span className="text-xs text-muted">({t.level})</span>
                </span>
                {t.active ? (
                  <Pill tone="green">active</Pill>
                ) : (
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() =>
                      api
                        .activateTarget(t.id)
                        .then(refresh)
                        .catch(setError)
                    }
                  >
                    Switch
                  </Button>
                )}
              </li>
            ))}
          </ul>

          {activeTarget && (
            <details className="mt-4" data-testid="company-profile">
              <summary className="cursor-pointer text-sm font-medium text-navy">
                Advanced options — company interview style
              </summary>
              <div className="mt-3 rounded-[0.6rem] border border-line bg-page p-3 text-sm">
                {(() => {
                  const info =
                    profiles.find((p) => p.id === activeTarget.companyProfileId) ??
                    profiles.find((p) => p.id === "generic") ??
                    null;
                  const profile = activeTarget.companyProfile;
                  return (
                    <>
                      <label className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-navy">Company profile</span>
                        <select
                          aria-label="Company profile"
                          value={info?.id ?? "generic"}
                          onChange={(e) =>
                            api
                              .updateTargetProfile(activeTarget.id, e.target.value)
                              .then(refresh)
                              .catch(setError)
                          }
                          className="rounded-[0.6rem] border border-line bg-surface px-2 py-1 text-sm"
                        >
                          {profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {info && (
                        <div className="mt-2 text-xs text-muted">
                          <p>
                            Typical loop:{" "}
                            {info.typicalLoop.map((s) => s.label).join(" → ")} · follow-up
                            depth {info.followUpDepth}
                          </p>
                          {info.behavioralFramework && (
                            <p className="mt-0.5">
                              {info.behavioralFramework.name}:{" "}
                              {info.behavioralFramework.themes.join(", ")}
                            </p>
                          )}
                          <p className="mt-1 italic">{info.disclaimer}</p>
                        </div>
                      )}
                      {profile && profile.values.length > 0 && (
                        <p className="mt-1 text-muted">
                          <span className="text-ink">Values:</span>{" "}
                          {profile.values.join(" · ")}
                        </p>
                      )}
                      {profile?.interviewStyle && (
                        <p className="mt-1 text-muted">
                          <span className="text-ink">Interview style:</span>{" "}
                          {profile.interviewStyle}
                        </p>
                      )}
                      {profile && profile.focusSkillIds.length > 0 && (
                        <p className="mt-1 text-muted">
                          <span className="text-ink">Focus areas:</span>{" "}
                          {profile.focusSkillIds.map((id) => skillLabel(id)).join(", ")}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            </details>
          )}
        </Card>
      )}

      {hasCandidate ? (
        <Card id="add-target">
          <SetupForm
            mode="target"
            title="Add another target role"
            onDone={() => {
              loadTargets();
              refresh();
            }}
          />
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-navy">
              Start over with a new resume
            </summary>
            <div className="mt-3">
              <SetupForm
                mode="workspace"
                onDone={(r) => {
                  if (r) setResult(r);
                  loadTargets();
                }}
              />
            </div>
          </details>
        </Card>
      ) : (
        <Card>
          <SetupForm
            mode="workspace"
            title="Set up your workspace"
            onDone={(r) => {
              if (r) setResult(r);
              loadTargets();
            }}
          />
        </Card>
      )}

      {result && (
        <div className="space-y-5" aria-live="polite">
          <Card>
            <SectionHeading
              title={`We found ${
                result.target.requirements.length + result.target.preferredSkills.length
              } important skills for this role`}
              description="Organised by importance and your current readiness."
            />
            <ul className="space-y-1.5 text-sm">
              {[...result.target.requirements, ...result.target.preferredSkills].map((r) => (
                <li key={r.skillId} className="flex items-center justify-between gap-2">
                  <span>{r.label || skillLabel(r.skillId)}</span>
                  <span className="flex items-center gap-2">
                    {r.boostedBy === "company-profile" && (
                      <Pill tone="green">company profile</Pill>
                    )}
                    <span className="text-xs text-muted">
                      {Math.round(r.importance * 100)}%
                    </span>
                    <Pill tone={r.kind === "required" ? "blue" : "muted"}>{r.kind}</Pill>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <SectionHeading
              title="Candidate skills"
              description={result.candidate.name ? `From ${result.candidate.name}'s resume.` : undefined}
            />
            <ul className="space-y-2">
              {result.candidate.skills.map((s) => (
                <li key={s.skillId} className="text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{skillLabel(s.skillId)}</span>
                    <span className="text-muted">
                      level {Math.round(s.level * 100)}%
                    </span>
                  </div>
                  {s.evidence && <p className="text-xs text-muted">“{s.evidence}”</p>}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <SectionHeading
              title="Identified gaps"
              description="The skills to work on first."
            />
            <PriorityList
              empty="No gaps detected — nice."
              items={result.gaps.map((g) => ({
                key: g.skillId,
                label: g.label || skillLabel(g.skillId),
                statusLabel: g.severity,
                tone: g.severity === "high" ? "amber" : g.severity === "medium" ? "blue" : "muted",
                readiness: g.currentScore,
                note: g.reason,
              }))}
            />
          </Card>

          <div className="flex items-center gap-3">
            <Link to="/prepare">
              <Button>Build my preparation plan</Button>
            </Link>
          </div>
        </div>
      )}

      {hasCandidate && (
        <Callout title="Preparing for more than one role?">
          Add another target above — each target keeps its own gaps and plan while sharing
          your interview evidence.
        </Callout>
      )}

      <PluginSlot slot="target.tabs" />
    </div>
  );
}
