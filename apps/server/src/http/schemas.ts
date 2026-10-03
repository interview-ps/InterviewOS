import { RoundTypeSchema, SkillIdSchema, MODE_IDS } from "@interview-os/core";
import { RUNTIME_KINDS } from "@interview-os/runtime";
import { z } from "zod";

export const SetupSchema = z.object({
  resumeText: z.string().min(1).max(190_000),
  jobDescription: z.string().min(1).max(190_000),
  company: z.string().min(1),
  role: z.string().min(1),
  level: z.enum(["junior", "mid", "senior", "staff"]),
  companyNotes: z.string().max(50_000).optional(),
});

export const ResumeSchema = z.object({ resumeText: z.string().min(1).max(190_000) });

export const JobSchema = SetupSchema.omit({ resumeText: true });

export const InterviewCreateSchema = z.object({
  plannedQuestions: z.number().int().positive().max(20).optional(),
  // "interview"|"practice" = session mode (v0.2); a §9.1 ModeId also accepted
  mode: z.string().max(32).optional(),
  focusSkillId: SkillIdSchema.optional(),
  actionId: z.string().min(1).optional(),
  roundType: RoundTypeSchema.optional(),
});

export const StoryPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  situation: z.string().max(20_000).optional(),
  task: z.string().max(20_000).optional(),
  action: z.string().max(20_000).optional(),
  result: z.string().max(20_000).optional(),
  skillIds: z.array(SkillIdSchema).optional(),
});

export const CODE_LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "java",
  "go",
  "cpp",
  "csharp",
  "ruby",
  "rust",
  "kotlin",
  "swift",
  "sql",
  "other",
] as const;

export const AnswerSchema = z.object({
  answer: z.string().min(1).max(190_000),
  /** §9.1: optional code submission, ≤ 50 KB, reviewed but not executed. */
  code: z.string().max(50 * 1024).optional(),
  language: z.enum(CODE_LANGUAGES).optional(),
});

export const ActionPatchSchema = z.object({
  status: z.enum(["open", "in_progress", "done", "superseded"]),
});

export const ActionCompleteSchema = z.object({
  checkedCriteria: z.array(z.string()).optional(),
});

export const TargetCreateSchema = z.object({
  jobDescription: z.string().min(1).max(190_000),
  company: z.string().min(1),
  role: z.string().min(1),
  level: z.enum(["junior", "mid", "senior", "staff"]),
  companyNotes: z.string().max(50_000).optional(),
});

export const TargetPatchSchema = z.object({
  companyProfileId: z.string().min(1).max(64),
});

export const LoopCreateSchema = z.object({
  rounds: z
    .array(
      z.object({
        mode: z.enum(MODE_IDS),
        label: z.string().max(80).optional(),
        plannedQuestions: z.number().int().min(1).max(6).optional(),
      }),
    )
    .min(2)
    .max(7)
    .optional(),
});

export const UsageEventSchema = z.object({ event: z.string().min(1).max(64) });

export const SettingsSchema = z.object({
  model: z.string().max(128).nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
  taskMode: z.enum(["app-server", "exec"]).optional(),
});

export const RuntimeSwitchSchema = z.object({ kind: z.enum(RUNTIME_KINDS) });
