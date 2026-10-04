import { defineSkill, type HookRequest } from "@interview-os/plugin-sdk";

interface Question {
  id: string;
  skillId: string;
  text: string;
  difficulty: "easy" | "medium" | "hard";
  expectedConcepts: string[];
}

const QUESTIONS: Question[] = [
  { id: "pg-idx-1", skillId: "sql.indexing", text: "How does a B-tree index speed up equality and range lookups in PostgreSQL?", difficulty: "medium", expectedConcepts: ["b-tree", "ordered keys", "page lookups"] },
  { id: "pg-idx-2", skillId: "sql.indexing", text: "When would you choose a partial index over a full index?", difficulty: "medium", expectedConcepts: ["index size", "predicate selectivity"] },
  { id: "pg-idx-3", skillId: "sql.indexing", text: "Why can a composite index on (a, b) fail to help a query filtering only on b?", difficulty: "hard", expectedConcepts: ["leftmost prefix", "column order"] },
  { id: "pg-txn-1", skillId: "sql.transactions", text: "Explain the difference between READ COMMITTED and REPEATABLE READ in PostgreSQL.", difficulty: "medium", expectedConcepts: ["snapshot", "isolation levels"] },
  { id: "pg-txn-2", skillId: "sql.transactions", text: "What is a serialization anomaly and how does SERIALIZABLE prevent it?", difficulty: "hard", expectedConcepts: ["write skew", "predicate locks"] },
  { id: "pg-txn-3", skillId: "sql.transactions", text: "How does MVCC let readers and writers avoid blocking each other?", difficulty: "medium", expectedConcepts: ["snapshots", "tuple versions"] },
  { id: "pg-opt-1", skillId: "sql.query-optimization", text: "Walk through how you would read an EXPLAIN ANALYZE plan for a slow join.", difficulty: "medium", expectedConcepts: ["node types", "estimates vs actual", "buffers"] },
  { id: "pg-opt-2", skillId: "sql.query-optimization", text: "Why might the planner choose a sequential scan over an index scan?", difficulty: "medium", expectedConcepts: ["cost model", "selectivity", "random I/O"] },
  { id: "pg-opt-3", skillId: "sql.query-optimization", text: "What do VACUUM and ANALYZE do, and what breaks when statistics are stale?", difficulty: "medium", expectedConcepts: ["dead tuples", "statistics", "autovacuum"] },
  { id: "pg-gen-1", skillId: "sql", text: "How do write-ahead logs make PostgreSQL crash-safe?", difficulty: "hard", expectedConcepts: ["wal", "replay", "durability"] },
];

const SQL_SKILLS = ["sql", "sql.query-optimization", "sql.indexing", "sql.transactions", "sql.locking"];

const TAB_SKILLS: { label: string; skills: string[] }[] = [
  { label: "Queries", skills: ["sql", "sql.query-optimization"] },
  { label: "Indexes", skills: ["sql.indexing"] },
  { label: "Transactions", skills: ["sql.transactions"] },
  { label: "Locking", skills: ["sql.locking"] },
];

interface SelfCheckItem {
  skillId: string;
  passed: boolean;
}

interface ReadinessDimension {
  label?: string;
  score: number | null;
  confidence: number;
  status?: string;
}

interface GapItem {
  skillId: string;
  label?: string;
  gap?: number;
  severity?: string;
}

type UINode = Record<string, unknown>;

function readinessCard(readiness: Record<string, ReadinessDimension>): UINode {
  const dims = SQL_SKILLS.map((id) => readiness[id]).filter(
    (d): d is ReadinessDimension => !!d && d.score !== null,
  );
  const mean =
    dims.length > 0
      ? dims.reduce((s, d) => s + (d.score ?? 0), 0) / dims.length
      : null;
  return {
    type: "card",
    title: "PostgreSQL readiness",
    subtitle: `${dims.length} SQL skills assessed`,
    children: [
      {
        type: "stat",
        label: "PostgreSQL readiness",
        value: mean === null ? "—" : `${Math.round(mean * 100)}%`,
        tone: mean === null ? "muted" : mean >= 0.6 ? "green" : mean >= 0.4 ? "blue" : "amber",
      },
      {
        type: "button",
        label: "Start PostgreSQL Deep Dive",
        variant: "primary",
        action: { type: "startInterview", modeId: "pg-deep-dive" },
      },
    ],
  };
}

function explainAnalyze(): UINode {
  return {
    type: "card",
    title: "Practice EXPLAIN ANALYZE",
    subtitle: "Read real query plans like a PostgreSQL DBA.",
    children: [
      {
        type: "text",
        text: "Practice interpreting EXPLAIN ANALYZE output: node types, estimates vs actuals, buffers.",
      },
      {
        type: "button",
        label: "Start practice",
        variant: "secondary",
        action: { type: "startPractice", skillId: "sql.query-optimization" },
      },
    ],
  };
}

function homePage(
  readiness: Record<string, ReadinessDimension>,
  gaps: GapItem[],
): UINode {
  const weaknesses = gaps
    .filter((g) => SQL_SKILLS.some((s) => g.skillId === s || g.skillId.startsWith(`${s}.`)))
    .slice(0, 5)
    .map((g) => ({
      text: `${g.label ?? g.skillId}${g.severity ? ` (${g.severity})` : ""}`,
      tone: g.severity === "high" ? "amber" : "muted",
    }));
  return {
    type: "stack",
    gap: "md",
    children: [
      {
        type: "tabs",
        tabs: TAB_SKILLS.map((tab) => ({
          label: tab.label,
          children: [
            {
              type: "stack",
              gap: "sm",
              children: tab.skills.map((skillId) => ({
                type: "skillScore",
                skillId,
                label: readiness[skillId]?.label ?? skillId,
                score: readiness[skillId]?.score ?? null,
                confidence: readiness[skillId]?.confidence ?? 0,
              })),
            },
          ],
        })),
      },
      { type: "divider" },
      weaknesses.length > 0
        ? { type: "card", title: "Recent weaknesses", children: [{ type: "list", items: weaknesses }] }
        : { type: "emptyState", title: "No PostgreSQL weaknesses detected", description: "SQL skills are on track." },
    ],
  };
}

type SuggestRequest = HookRequest<"questions.suggest">;
type UIRequest = HookRequest<"ui.render">;
type FrameRunRequest = HookRequest<"ui.frameRun">;
type ReviewRequest = HookRequest<"evaluation.review">;

const REVIEW_KEYWORDS: { re: RegExp; text: string }[] = [
  {
    re: /\bexplain(\s+analyze)?\b|query plan/i,
    text: "Referenced the query planner — good instinct for a PostgreSQL round.",
  },
  {
    re: /\bmvcc|snapshot|isolation level/i,
    text: "Touched on MVCC/isolation — core PostgreSQL transaction knowledge.",
  },
  {
    re: /\bb-?tree|index(es)?\b/i,
    text: "Mentioned indexing — make sure to tie it to selectivity and cost.",
  },
];

export default defineSkill({
  id: "postgres-interviewer",
  permissions: [
    "candidate.read",
    "target.read",
    "readiness.read",
    "taxonomy.read",
    "answers.read",
    "evidence.write",
  ],
  capabilities: ["interview", "evaluation", "question_source", "ui"],
  inputs: ["candidate", "target", "readiness", "gaps", "request"],
  handlers: {
    /** questions.suggest — the deterministic PostgreSQL question bank. */
    "questions.suggest"(req: SuggestRequest, ctx) {
      const bias = (ctx.settings?.["difficulty-bias"] as string) ?? "medium";
      const rank = { easy: 0, medium: 1, hard: 2 }[bias] ?? 1;
      const inScope = req.skillId
        ? QUESTIONS.filter(
            (q) =>
              q.skillId === req.skillId ||
              q.skillId.startsWith(`${req.skillId}.`),
          )
        : QUESTIONS;
      const ranked = [...inScope].sort(
        (a, b) =>
          Math.abs(({ easy: 0, medium: 1, hard: 2 })[a.difficulty] - rank) -
          Math.abs(({ easy: 0, medium: 1, hard: 2 })[b.difficulty] - rank),
      );
      const questions = ranked
        .slice(0, req.count ?? inScope.length)
        .map(({ id: _id, ...q }) => q);
      return { questions };
    },

    /** ui.render — declarative contributions (slot cards + home page). */
    "ui.render"(req: UIRequest, ctx) {
      const dims = (ctx.input?.readiness ?? {}) as Record<
        string,
        ReadinessDimension
      >;
      const gapList = Array.isArray(ctx.input?.gaps)
        ? (ctx.input.gaps as GapItem[])
        : [];
      const ui =
        req.component === "readiness-card"
          ? readinessCard(dims)
          : req.component === "explain-analyze"
            ? explainAnalyze()
            : req.component === "home"
              ? homePage(dims, gapList)
              : { type: "emptyState", title: "Unknown component" };
      return { ui };
    },

    /** ui.frameRun — stateless invocations from the sandboxed frame. */
    "ui.frameRun"(req: FrameRunRequest) {
      const inner = (req.request ?? {}) as {
        skillId?: string;
        count?: number;
      };
      const inScope = inner.skillId
        ? QUESTIONS.filter(
            (q) =>
              q.skillId === inner.skillId ||
              q.skillId.startsWith(`${inner.skillId}.`),
          )
        : QUESTIONS;
      return {
        output: { questions: inScope.slice(0, inner.count ?? inScope.length) },
      };
    },

    /**
     * evaluation.review — lightweight review observations on SQL answers.
     * `answer` is null unless the user granted answers.read.
     */
    "evaluation.review"(req: ReviewRequest) {
      const observations: { text: string; tone: string }[] = [];
      if (req.answer === null) {
        observations.push({
          text: "Answer text unavailable — grant answers.read to include it in PostgreSQL reviews.",
          tone: "muted",
        });
      } else {
        for (const k of REVIEW_KEYWORDS) {
          if (k.re.test(req.answer.text)) observations.push({ text: k.text, tone: "green" });
        }
        if (observations.length === 0) {
          observations.push({
            text: "No PostgreSQL-specific concepts detected in this answer.",
            tone: "amber",
          });
        }
      }
      return { observations: observations.slice(0, 5) };
    },
  },

  /**
   * Legacy path — kept for the self-check evidence flow (POST /run with
   * {selfCheck: [...]}) and for hosts that never adopted hook dispatch.
   */
  execute({ input, request }) {
    const readiness = input?.readiness;
    const gaps = input?.gaps;
    const req = (request ?? {}) as {
      kind?: string;
      skillId?: string;
      count?: number;
      component?: string;
      selfCheck?: SelfCheckItem[];
    };

    if (req.kind === "ui") {
      const dims = (readiness ?? {}) as Record<string, ReadinessDimension>;
      const gapList = Array.isArray(gaps) ? (gaps as GapItem[]) : [];
      const ui =
        req.component === "readiness-card"
          ? readinessCard(dims)
          : req.component === "explain-analyze"
            ? explainAnalyze()
            : req.component === "home"
              ? homePage(dims, gapList)
              : { type: "emptyState", title: "Unknown component" };
      return { ui };
    }

    if (req.kind === "ui-frame") {
      const inScope = req.skillId
        ? QUESTIONS.filter(
            (q) =>
              q.skillId === req.skillId ||
              q.skillId.startsWith(`${req.skillId}.`),
          )
        : QUESTIONS;
      return { output: { questions: inScope.slice(0, req.count ?? inScope.length) } };
    }

    const inScope = req.skillId
      ? QUESTIONS.filter(
          (q) => q.skillId === req.skillId || q.skillId.startsWith(`${req.skillId}.`),
        )
      : QUESTIONS;
    const questions = inScope.slice(0, req.count ?? inScope.length);

    const evidenceProposals = Array.isArray(req.selfCheck)
      ? req.selfCheck
          .filter(
            (item) =>
              item &&
              typeof item.skillId === "string" &&
              typeof item.passed === "boolean",
          )
          .map((item) => ({
            skillId: item.skillId,
            score: item.passed ? 0.7 : 0.3,
            confidence: 0.4,
            observation: `PostgreSQL self-check ${item.passed ? "passed" : "failed"} on ${item.skillId}`,
          }))
      : undefined;

    return {
      questions,
      ...(evidenceProposals ? { evidenceProposals } : {}),
    };
  },
});
