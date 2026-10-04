import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

export const QuestionDifficultySchema = z.enum(["easy", "medium", "hard"]);
export type QuestionDifficulty = z.infer<typeof QuestionDifficultySchema>;

export const ExpectedConceptSchema = z.object({
  concept: z.string(),
  skillId: SkillIdSchema,
  keywords: z.array(z.string()).default([]),
});
export type ExpectedConcept = z.infer<typeof ExpectedConceptSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  skillId: SkillIdSchema,
  topic: z.string(),
  text: z.string(),
  subSkills: z.array(SkillIdSchema).default([]),
  expectedConcepts: z.array(ExpectedConceptSchema).default([]),
  difficulty: QuestionDifficultySchema,
  followUpOf: z.string().nullish(),
  createdAt: z.string().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const AnswerSchema = z.object({
  id: z.string(),
  questionId: z.string(),
  sessionId: z.string().optional(),
  text: z.string(),
  createdAt: z.string().optional(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const InterviewStatusSchema = z.enum([
  "created",
  "analyzing",
  "ready",
  "question",
  "answer",
  "evaluating",
  "follow_up",
  "complete",
  "debrief",
]);
export type InterviewStatus = z.infer<typeof InterviewStatusSchema>;

export const InterviewSessionSchema = z.object({
  id: z.string(),
  status: InterviewStatusSchema.default("created"),
  currentRound: z.number().int().min(0).default(0),
  plannedQuestions: z.number().int().positive().default(4),
  questionIds: z.array(z.string()).default([]),
  answerIds: z.array(z.string()).default([]),
  runtimeThreadId: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type InterviewSession = z.infer<typeof InterviewSessionSchema>;

export const InterviewStateSliceSchema = z.object({
  sessionId: z.string().optional(),
  currentRound: z.number().int().min(0).default(0),
  previousQuestions: z.array(QuestionSchema).default([]),
  previousAnswers: z.array(AnswerSchema).default([]),
  interviewerObservations: z.array(z.string()).default([]),
  activeQuestion: QuestionSchema.optional(),
});
export type InterviewStateSlice = z.infer<typeof InterviewStateSliceSchema>;

export { selectNextSkill, difficultyFor } from "./prioritize.js";
export type {
  LoopWeakSkill,
  SelectionFactors,
  SkillCandidate,
  SelectNextSkillInput,
  SelectNextSkillResult,
} from "./prioritize.js";
export { RoundTypeSchema, inRound, roundFallbackRequirements } from "./rounds.js";
export type { RoundType } from "./rounds.js";
export * from "./loop.js";
export * from "./voice.js";
export * from "./modes/index.js";
export {
  INTERVIEW_STATES,
  InterviewEventSchema,
  transition,
  canTransition,
  nextEvents,
  InvalidTransitionError,
} from "./state-machine.js";
export type { InterviewEvent } from "./state-machine.js";
