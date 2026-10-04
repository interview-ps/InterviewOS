import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

export * from "./resources.js";

export const PrepActionStatusSchema = z.enum([
  "open",
  "in_progress",
  "done",
  "superseded",
]);
export type PrepActionStatus = z.infer<typeof PrepActionStatusSchema>;

export const PrepActionSchema = z.object({
  id: z.string(),
  skillId: SkillIdSchema,
  priority: z.number(),
  reason: z.string(),
  action: z.string(),
  successCriteria: z.array(z.string()).default([]),
  status: PrepActionStatusSchema.default("open"),
  createdAt: z.string(),
  sourceEvidenceIds: z.array(z.string()).default([]),
});
export type PrepAction = z.infer<typeof PrepActionSchema>;

export const PracticeRecordSchema = z.object({
  id: z.string(),
  skillId: SkillIdSchema,
  actionId: z.string().optional(),
  note: z.string(),
  score: z.number().min(0).max(1).optional(),
  createdAt: z.string(),
});
export type PracticeRecord = z.infer<typeof PracticeRecordSchema>;

export const PreparationStateSchema = z.object({
  priorities: z.array(SkillIdSchema).default([]),
  completedTopics: z.array(z.string()).default([]),
  nextActions: z.array(PrepActionSchema).default([]),
  practiceHistory: z.array(PracticeRecordSchema).default([]),
});
export type PreparationState = z.infer<typeof PreparationStateSchema>;
