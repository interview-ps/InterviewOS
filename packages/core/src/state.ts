import { z } from "zod";
import { CandidateProfileSchema } from "./candidate/index.js";
import { TargetRoleSchema } from "./target/index.js";
import { AssessmentStateSchema } from "./assessment/index.js";
import { PreparationStateSchema } from "./preparation/index.js";
import { InterviewStateSliceSchema } from "./interview/index.js";
import { ReadinessGraphSchema } from "./readiness/schema.js";

export const InterviewOSStateSchema = z.object({
  candidate: CandidateProfileSchema,
  target: TargetRoleSchema,
  assessment: AssessmentStateSchema,
  preparation: PreparationStateSchema,
  interview: InterviewStateSliceSchema,
  readiness: ReadinessGraphSchema,
});
export type InterviewOSState = z.infer<typeof InterviewOSStateSchema>;
