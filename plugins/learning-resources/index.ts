import { defineSkill } from "@interview-os/plugin-sdk";

interface CatalogEntry {
  skillPrefix: string;
  title: string;
  url?: string;
  summary?: string;
  kind: "docs" | "explanation" | "practice" | "article" | "video";
}

const CATALOG: CatalogEntry[] = [
  {
    skillPrefix: "sql",
    title: "PostgreSQL tutorial",
    url: "https://www.postgresql.org/docs/current/tutorial.html",
    kind: "docs",
  },
  {
    skillPrefix: "system-design",
    title: "Design interview checklist",
    summary: "Requirements → capacity → high-level design → deep dive → trade-offs.",
    kind: "explanation",
  },
  {
    skillPrefix: "distributed-systems",
    title: "Distributed systems primer",
    summary: "Replication, partitioning, consistency — the core vocabulary.",
    kind: "article",
  },
  {
    skillPrefix: "behavioral",
    title: "STAR practice",
    summary: "Rehearse three stories aloud; time each at ~2 minutes.",
    kind: "practice",
  },
  {
    skillPrefix: "coding",
    title: "Deliberate practice loop",
    summary: "Solve one problem timed, then write up the complexity analysis.",
    kind: "practice",
  },
];

function suggest(skillIds: string[]) {
  return {
    resources: CATALOG.filter((entry) =>
      skillIds.some(
        (s) => s === entry.skillPrefix || s.startsWith(`${entry.skillPrefix}.`),
      ),
    ).map(({ skillPrefix: _p, ...rest }) => rest),
  };
}

export default defineSkill({
  id: "learning-resources",
  permissions: ["taxonomy.read"],
  capabilities: ["resources"],
  inputs: ["request"],
  handlers: {
    /** resources.suggest — Plugin API v1 contract. */
    "resources.suggest"(req: { skillIds: string[] }) {
      return suggest(req.skillIds ?? []);
    },
  },
  execute({ request }) {
    const skillIds = ((request ?? {}) as { skillIds?: string[] }).skillIds ?? [];
    return suggest(skillIds);
  },
});
