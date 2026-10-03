import { childrenOf } from "../../taxonomy/index.js";
import type { SkillId } from "../../skill-id.js";
import {
  inSubtree,
  type FollowUpDecision,
  type ModeDefinition,
  type ModeState,
} from "./types.js";

export type DesignStatus = "not_covered" | "partial" | "covered";
const STATUS_RANK: Record<DesignStatus, number> = {
  not_covered: 0,
  partial: 1,
  covered: 2,
};

export interface DesignDimensionState {
  status: DesignStatus;
  notes: string;
}

export interface SystemDesignState extends ModeState {
  problem: string | null;
  dimensions: Record<string, DesignDimensionState>;
  /** Dimension currently being probed (rubric id). */
  focusDimension: string | null;
}

const RUBRIC: ModeDefinition["rubric"] = [
  { id: "requirements", label: "Requirements", description: "Clarifies functional scope before designing." },
  { id: "constraints", label: "Constraints", description: "Surfaces constraints and non-functional goals." },
  { id: "scaleAssumptions", label: "Scale assumptions", description: "Quantifies load: QPS, storage, users — with numbers." },
  { id: "architecture", label: "Architecture", description: "Presents a coherent high-level component design." },
  { id: "dataModel", label: "Data model", description: "Defines entities, schema and access patterns." },
  { id: "apis", label: "APIs", description: "Specifies the external API surface." },
  { id: "storage", label: "Storage", description: "Chooses and justifies storage technology." },
  { id: "caching", label: "Caching", description: "Uses caching appropriately with invalidation reasoning." },
  { id: "reliability", label: "Reliability", description: "Covers failure modes, redundancy, monitoring." },
  { id: "scalability", label: "Scalability", description: "Shows how the design scales with growth." },
  { id: "tradeOffs", label: "Trade-offs", description: "Discusses alternatives and justifies decisions." },
];

/** The rubric dimensions the session walks turn by turn (order = rubric order). */
export const DESIGN_DIMENSION_IDS = RUBRIC.filter((d) => d.id !== "communication").map(
  (d) => d.id,
);

/** Maps a design rubric dimension to the taxonomy skill a probe targets. */
export const DIMENSION_SKILL: Record<string, SkillId> = {
  requirements: "system-design.requirements-analysis",
  constraints: "system-design",
  scaleAssumptions: "system-design.capacity-estimation",
  architecture: "system-design",
  dataModel: "system-design.data-modeling",
  apis: "apis",
  storage: "sql",
  caching: "distributed-systems.caching",
  reliability: "system-design.reliability",
  scalability: "system-design.scalability",
  tradeOffs: "system-design",
};

/** First dimension that is not yet covered, in rubric order. */
export function nextUncoveredDimension(state: SystemDesignState): string | null {
  for (const id of DESIGN_DIMENSION_IDS) {
    if (state.dimensions[id]?.status !== "covered") return id;
  }
  return null;
}

export const systemDesignMode: ModeDefinition = {
  id: "system_design",
  label: "System design",
  description: "Open-ended design of a larger system with concrete scale numbers — requirements → estimation → design → trade-offs.",
  inScope: (skillId: SkillId) =>
    inSubtree(skillId, "system-design") || inSubtree(skillId, "distributed-systems"),
  fallbackSkills: [
    "system-design",
    ...childrenOf("system-design" as SkillId),
    "distributed-systems",
    ...childrenOf("distributed-systems" as SkillId),
  ],
  rubric: RUBRIC,
  initialState: (): SystemDesignState => ({
    problem: null,
    dimensions: Object.fromEntries(
      DESIGN_DIMENSION_IDS.map((id) => [id, { status: "not_covered", notes: "" }]),
    ),
    focusDimension: null,
  }),
  reduce: (state, evaluation, question): SystemDesignState => {
    const next = { ...state, dimensions: { ...(state as SystemDesignState).dimensions } } as SystemDesignState;
    const problem = question.extra?.problem;
    if (typeof problem === "string" && problem) next.problem = problem;
    const focus = question.extra?.focusDimension;
    if (typeof focus === "string" && focus) next.focusDimension = focus;
    for (const update of evaluation.designUpdates ?? []) {
      const cur = next.dimensions[update.dimension];
      if (!cur) continue;
      const rank = STATUS_RANK[update.status];
      if (rank > STATUS_RANK[cur.status]) {
        next.dimensions[update.dimension] = {
          status: update.status,
          notes: update.notes || cur.notes,
        };
      } else if (update.notes && rank === STATUS_RANK[cur.status]) {
        cur.notes = update.notes;
      }
    }
    return next;
  },
  // The session itself walks uncovered dimensions — never a follow-up chain.
  followUp: (): FollowUpDecision => ({
    ask: false,
    reason: "system-design sessions walk uncovered dimensions directly",
  }),
};
