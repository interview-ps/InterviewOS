import type { Permission, SkillManifest } from "./manifest.js";

export type PermissionAccess = "READ" | "WRITE" | "INVOKE" | "DENIED" | "UI";

export interface PermissionViewEntry {
  category: string;
  access: PermissionAccess;
  requested: boolean;
  granted: boolean;
  /** Optional human-readable detail (e.g. which UI slots are contributed). */
  detail?: string;
}

interface CategorySpec {
  category: string;
  reads: Permission[];
  writes: Permission[];
  invokes: Permission[];
}

const CATEGORIES: CategorySpec[] = [
  { category: "Candidate Profile", reads: ["candidate.read"], writes: ["candidate.write"], invokes: [] },
  { category: "Resume", reads: ["resume.read"], writes: ["resume.write"], invokes: [] },
  { category: "Target", reads: ["target.read"], writes: ["target.write"], invokes: [] },
  { category: "Readiness", reads: ["readiness.read", "taxonomy.read"], writes: [], invokes: [] },
  { category: "Interview History", reads: ["interview.read"], writes: ["interview.write"], invokes: [] },
  { category: "Interview Answers", reads: ["answers.read"], writes: [], invokes: [] },
  { category: "STAR Stories", reads: ["stories.read"], writes: ["stories.write"], invokes: [] },
  { category: "Evidence (write)", reads: [], writes: ["evidence.write"], invokes: [] },
  { category: "AI Runtime", reads: [], writes: [], invokes: ["runtime.invoke"] },
];

const ISOLATION_DENIED = [
  "Local Files",
  "Network",
  "Environment/Secrets",
  "Commands",
];

/**
 * Fixed permission view for UI inspection: every category, what the manifest
 * requests, what is actually granted, and the effective access level. Files,
 * network, env and commands are always DENIED — enforced by process isolation,
 * not by grants.
 */
export function describePermissions(
  manifest: Pick<SkillManifest, "permissions" | "ui" | "interviewModes">,
  granted: readonly Permission[] = manifest.permissions,
  opts: { enabled?: boolean } = {},
): PermissionViewEntry[] {
  const requested = new Set(manifest.permissions);
  const grantedSet = new Set(granted);
  const view: PermissionViewEntry[] = CATEGORIES.map((spec) => {
    const wanted = [...spec.reads, ...spec.writes, ...spec.invokes].filter((p) =>
      requested.has(p),
    );
    const isGranted = wanted.length > 0 && wanted.every((p) => grantedSet.has(p));
    const access: PermissionAccess = !isGranted
      ? "DENIED"
      : spec.invokes.length > 0
        ? "INVOKE"
        : spec.writes.some((p) => grantedSet.has(p))
          ? "WRITE"
          : "READ";
    return {
      category: spec.category,
      access,
      requested: wanted.length > 0,
      granted: isGranted,
    };
  });
  for (const category of ISOLATION_DENIED) {
    view.push({ category, access: "DENIED", requested: false, granted: false });
  }
  const ui = manifest.ui;
  if (ui || manifest.interviewModes?.length) {
    const parts: string[] = [];
    const slots = Object.keys(ui?.slots ?? {});
    if (slots.length > 0) parts.push(`slots: ${slots.join(", ")}`);
    if (ui?.pages?.length) parts.push(`pages: ${ui.pages.map((p) => p.path).join(", ")}`);
    if (ui?.commands?.length) parts.push(`commands: ${ui.commands.map((c) => c.label).join("; ")}`);
    if (ui?.navigation?.length) parts.push(`nav: ${ui.navigation.map((n) => n.label).join(", ")}`);
    if (manifest.interviewModes?.length) {
      parts.push(`interview modes: ${manifest.interviewModes.map((m) => m.label).join("; ")}`);
    }
    view.push({
      category: "UI Contributions",
      access: "UI",
      requested: true,
      granted: opts.enabled ?? false,
      detail: parts.join(" · ") || "declared UI contributions",
    });
  }
  return view;
}
