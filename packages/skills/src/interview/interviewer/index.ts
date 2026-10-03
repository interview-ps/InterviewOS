import { z } from "zod";
import {
  ExpectedConceptSchema,
  isModeId,
  LevelSchema,
  QuestionDifficultySchema,
  RoundTypeSchema,
  type SkillId,
  type SkillManifest,
} from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIds, normalizeSkillIdValue } from "../../framework/common.js";
import { INTERVIEWER_PROMPT } from "./prompt.js";
import { TECHNICAL_INTERVIEWER_PROMPT } from "../modes/technical/interviewer.js";
import { CODING_INTERVIEWER_PROMPT } from "../modes/coding/interviewer.js";
import { SYSTEM_DESIGN_INTERVIEWER_PROMPT } from "../modes/system-design/interviewer.js";
import { BEHAVIORAL_INTERVIEWER_PROMPT } from "../modes/behavioral/interviewer.js";
import { HIRING_MANAGER_INTERVIEWER_PROMPT } from "../modes/hiring-manager/interviewer.js";
import { HR_INTERVIEWER_PROMPT } from "../modes/hr/interviewer.js";

export const CodingProblemSchema = z.object({
  title: z.string(),
  statement: z.string(),
  constraints: z.array(z.string()).default([]),
  examples: z
    .array(
      z.object({
        input: z.string(),
        output: z.string(),
        explanation: z.string().default(""),
      }),
    )
    .default([]),
});
export type CodingProblem = z.infer<typeof CodingProblemSchema>;

export const InterviewerInputSchema = z.object({
  skillId: z.string(),
  label: z.string(),
  role: z.string(),
  level: LevelSchema,
  company: z.string(),
  reason: z.string(),
  previousQuestions: z.array(z.string()),
  candidateSummary: z.string(),
  /** §8.4 round type — shapes the interviewer persona. */
  roundType: RoundTypeSchema.default("mixed"),
  /** §9.1 interview mode. `mixed` keeps v0.2 behavior. */
  mode: RoundTypeSchema.optional(),
  /** Per-mode state blob from the previous turns (e.g. design-dimension status). */
  modeState: z.record(z.string(), z.unknown()).default({}),
  /** §9.2/§9.4: when set, this question is a follow-up on the parent. */
  followUp: z
    .object({ parentQuestion: z.string(), focus: z.string() })
    .nullable()
    .default(null),
  /** §9.3 company profile guidance block (already-rendered text). */
  companyGuidance: z.string().default(""),
  /** Engine-suggested difficulty for this question. */
  difficulty: QuestionDifficultySchema.optional(),
  /** §9.1 system-design: dimension the interviewer should focus on. */
  focusDimension: z.string().nullable().default(null),
  /** Company behavioral themes (values etc.), for behavioral/hr questions. */
  companyThemes: z.array(z.string()).default([]),
  /** Titles of the candidate's STAR stories a behavioral interviewer may reference. */
  storyTitles: z.array(z.string()).default([]),
  /** §9.4 loop rounds: earlier rounds' observations + weak-skill labels. */
  priorRoundObservations: z.array(z.string()).default([]),
});
export type InterviewerInput = z.input<typeof InterviewerInputSchema>;

const InterviewerConceptSchema = z.object({
  concept: z.string(),
  skillId: z.string(),
  keywords: z.array(z.string()).default([]),
});

export const InterviewerOutputSchema = z.object({
  question: z.string(),
  topic: z.string(),
  skillId: z.string(),
  subSkills: z.array(z.string()).default([]),
  expectedConcepts: z.array(InterviewerConceptSchema).default([]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  /** §9.1 coding: the problem statement; system_design turn 1: a string problem. */
  problem: z.union([CodingProblemSchema, z.string()]).nullable().default(null),
  /** §9.1 system_design: dimension probed this turn. */
  focusDimension: z.string().nullable().default(null),
});

export interface InterviewerOutput {
  question: string;
  topic: string;
  skillId: SkillId;
  subSkills: SkillId[];
  expectedConcepts: Array<{ concept: string; skillId: SkillId; keywords: string[] }>;
  difficulty: "easy" | "medium" | "hard";
  problem: CodingProblem | string | null;
  focusDimension: string | null;
}

const MODE_PROMPTS: Record<string, string> = {
  technical: TECHNICAL_INTERVIEWER_PROMPT,
  coding: CODING_INTERVIEWER_PROMPT,
  system_design: SYSTEM_DESIGN_INTERVIEWER_PROMPT,
  behavioral: BEHAVIORAL_INTERVIEWER_PROMPT,
  hiring_manager: HIRING_MANAGER_INTERVIEWER_PROMPT,
  hr: HR_INTERVIEWER_PROMPT,
};

const manifest: SkillManifest = {
  id: "interviewer",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Asks the next interview question for a mode — main questions, follow-ups, coding/design problems.",
  inputs: [
    { key: "skillId", permission: "readiness.read" },
    { key: "label", permission: "readiness.read" },
    { key: "role", permission: "target.read" },
    { key: "level", permission: "target.read" },
    { key: "company", permission: "target.read" },
    { key: "reason", permission: "interview.read" },
    { key: "previousQuestions", permission: "interview.read" },
    { key: "candidateSummary", permission: "candidate.read" },
    { key: "roundType", permission: "interview.read" },
    { key: "mode", permission: "interview.read" },
    { key: "modeState", permission: "interview.read" },
    { key: "followUp", permission: "interview.read" },
    { key: "companyGuidance", permission: "target.read" },
    { key: "difficulty", permission: "interview.read" },
    { key: "focusDimension", permission: "interview.read" },
    { key: "companyThemes", permission: "target.read" },
    { key: "storyTitles", permission: "stories.read" },
    { key: "priorRoundObservations", permission: "interview.read" },
  ],
  outputs: ["question", "topic", "expectedConcepts", "problem", "focusDimension"],
  permissions: [
    "interview.read",
    "readiness.read",
    "target.read",
    "candidate.read",
    "stories.read",
    "runtime.invoke",
    "interview.write",
  ],
};

export const interviewer: InterviewSkill<
  z.input<typeof InterviewerInputSchema>,
  InterviewerOutput
> = {
  id: "interviewer",
  manifest,
  inputSchema: InterviewerInputSchema,
  outputSchema: InterviewerOutputSchema as z.ZodType<InterviewerOutput>,
  async execute(input, ctx) {
    const mode = input.mode ?? input.roundType;
    const taskId =
      mode === "mixed" || !isModeId(mode) ? "interviewer" : `interviewer.${mode}`;
    let instructions =
      mode === "mixed" || !isModeId(mode)
        ? INTERVIEWER_PROMPT
        : MODE_PROMPTS[mode]!;
    if ((input.priorRoundObservations?.length ?? 0) > 0) {
      instructions +=
        `\n\nThis is a later round of an interview loop. input.priorRoundObservations` +
        ` lists what earlier rounds noticed — use them to probe related weaknesses` +
        ` (e.g. a weak area's neighbours), but never mention another interviewer's` +
        ` notes or earlier rounds verbatim to the candidate.`;
    }
    const output = await runStructured(ctx, {
      taskId,
      instructions,
      input,
      schema: InterviewerOutputSchema,
      streamField: "question",
      // interviewer prefers the session thread when one is attached to ctx
      session: ctx.runtimeSessionId
        ? { runtimeSessionId: ctx.runtimeSessionId }
        : undefined,
    });
    const skillId = normalizeSkillIdValue(output.skillId) ?? (input.skillId as SkillId);
    return {
      question: output.question,
      topic: output.topic,
      skillId,
      subSkills: normalizeSkillIds(output.subSkills),
      expectedConcepts: output.expectedConcepts
        .map((c) => ({ ...c, skillId: normalizeSkillIdValue(c.skillId) }))
        .filter((c): c is { concept: string; skillId: SkillId; keywords: string[] } => c.skillId !== null),
      difficulty: output.difficulty,
      problem: output.problem,
      focusDimension: output.focusDimension,
    };
  },
};
