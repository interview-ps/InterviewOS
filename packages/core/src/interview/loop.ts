import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";
import { MODE_IDS } from "./modes/types.js";

export const LoopModeSchema = z.enum(MODE_IDS);
export type LoopMode = z.infer<typeof LoopModeSchema>;

/** Snapshot of readiness at a loop round boundary: overall + per-requirement. */
export const ReadinessSnapshotSchema = z.object({
  overall: z.number().nullable(),
  requirements: z.record(z.string(), z.number().nullable()),
});
export type ReadinessSnapshot = z.infer<typeof ReadinessSnapshotSchema>;

/** §9.4: deterministic cross-round handoff computed from a round's evaluations. */
export const RoundHandoffSchema = z.object({
  /** Skills scoring < 0.5 this round (unique), each with its evidence observation. */
  weakSkills: z.array(
    z.object({
      skillId: SkillIdSchema,
      label: z.string().default(""),
      score: z.number(),
      observation: z.string(),
    }),
  ),
  /** Skills scoring ≥ 0.75 this round (unique). */
  strongSkills: z.array(
    z.object({
      skillId: SkillIdSchema,
      label: z.string().default(""),
      score: z.number(),
    }),
  ),
  /** Evaluation summaries (≤ 3, truncated). */
  observations: z.array(z.string()),
});
export type RoundHandoff = z.infer<typeof RoundHandoffSchema>;

/** §9.4: per-skill readiness movement evidenced by a round's evaluations. */
export const SkillDeltaSchema = z.object({
  skillId: SkillIdSchema,
  label: z.string().default(""),
  /** First evaluation's `before` and the last's `after` for this skill. */
  before: z.number().nullable(),
  after: z.number().nullable(),
});
export type SkillDelta = z.infer<typeof SkillDeltaSchema>;

export const LoopRoundSchema = z.object({
  mode: LoopModeSchema,
  label: z.string().default(""),
  plannedQuestions: z.number().int().min(1).max(6),
  sessionId: z.string().nullable().default(null),
  status: z.enum(["pending", "in_progress", "complete"]).default("pending"),
  readinessBefore: ReadinessSnapshotSchema.nullable().default(null),
  readinessAfter: ReadinessSnapshotSchema.nullable().default(null),
  handoff: RoundHandoffSchema.nullable().default(null),
  skillDeltas: z.array(SkillDeltaSchema).default([]),
});
export type LoopRound = z.infer<typeof LoopRoundSchema>;

/** Per-round signal in the loop debrief — evidence-backed, never hire/no-hire. */
export const LoopRoundSignalSchema = z.object({
  mode: z.string(),
  label: z.string().default(""),
  signal: z.enum(["strong", "mixed", "weak"]),
  evidence: z.array(z.string()).default([]),
});

export const LoopDebriefSchema = z.object({
  summary: z.string(),
  rounds: z.array(LoopRoundSignalSchema),
  readinessChange: z.object({
    before: z.number().nullable(),
    after: z.number().nullable(),
  }),
  topActions: z.array(z.string()).default([]),
});
export type LoopDebrief = z.infer<typeof LoopDebriefSchema>;
