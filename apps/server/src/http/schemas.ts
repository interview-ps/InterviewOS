import {
  ModeIdSchema,
  QuestionDifficultySchema,
  RoundTypeSchema,
  SkillIdSchema,
  MODE_IDS,
  PermissionSchema,
  SlugIdSchema,
  VoiceMetricsSchema,
} from "@interview-os/core";
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
  /** v0.4: ground the session on a stored external context. */
  contextId: z.string().min(1).max(120).optional(),
  /** v0.4: "<pluginId>:<modeId>" — a plugin-declared interview mode. */
  pluginModeId: z.string().min(3).max(160).optional(),
});

/** v0.4: declarative plugin-UI render request. */
export const PluginUIRenderSchema = z.object({
  slot: z.string().min(1).max(60).optional(),
  component: z.string().min(1).max(80),
  page: z.string().min(1).max(120).optional(),
  params: z.unknown().optional(),
});

/** v0.4: frame data request — which declared frame the slices are for. */
export const PluginUIFrameDataSchema = z
  .object({
    component: z.string().min(1).max(80).optional(),
    page: z.string().min(1).max(120).optional(),
  })
  .refine((v) => v.component !== undefined || v.page !== undefined, {
    message: "component or page is required",
  });

/** v0.4: frame run request — stateless invocation, bounded payload. */
export const PluginUIFrameRunSchema = z
  .object({
    component: z.string().min(1).max(80).optional(),
    page: z.string().min(1).max(120).optional(),
    request: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.component !== undefined || v.page !== undefined, {
    message: "component or page is required",
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
  /** v0.4 voice mode: client-measured delivery metrics (feedback only). */
  voice: VoiceMetricsSchema.optional(),
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
  questionSources: z
    .object({
      companyPacks: z.boolean().optional(),
      rolePacks: z.boolean().optional(),
      userBank: z.boolean().optional(),
      plugins: z.array(z.string().max(80)).optional(),
    })
    .optional(),
  voice: z
    .object({
      enabled: z.boolean().optional(),
      speakQuestions: z.boolean().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------- v0.4 MCP

export const McpServerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  allowedTools: z.array(z.string().min(1).max(64)).optional(),
});

export const McpContextFetchSchema = z.object({
  serverId: SlugIdSchema,
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).optional(),
  title: z.string().min(1).max(200).optional(),
});

// -------------------------------------------------------------- v0.4 import

export const ImportSchema = z.object({
  bundle: z.unknown(),
  /** Destructive replace requires an explicit confirmation. */
  confirm: z.literal("replace"),
});

// ---------------------------------------------------------------- v0.4 packs

export const PackInstallSchema = z.object({
  kind: z.enum(["company", "role"]),
  url: z.string().min(1).max(2000),
});

export const RolePackAssignSchema = z.object({
  rolePackId: z.string().min(1).max(80).nullable(),
});

export const InterviewPackCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  author: z.string().max(120).optional(),
  version: z.string().min(1).max(32).optional(),
  skills: z.array(SkillIdSchema).min(1).max(12),
  rounds: z
    .array(
      z.object({
        mode: ModeIdSchema,
        label: z.string().min(1).max(80),
        plannedQuestions: z.number().int().min(1).max(6),
      }),
    )
    .min(2)
    .max(7),
  durationMinutes: z.number().int().min(15).max(600),
});

export const InterviewPackImportSchema = z.object({
  content: z.string().min(1).max(200_000),
});

export const QuestionBankAddSchema = z.object({
  skillId: SkillIdSchema,
  text: z.string().min(10).max(1200),
  difficulty: QuestionDifficultySchema.optional(),
  mode: ModeIdSchema.optional(),
});

export const QuestionBankImportSchema = z.object({
  content: z.string().min(1).max(500_000),
});

/** v1: kind may be a built-in or a trusted local provider — route validates. */
export const RuntimeSwitchSchema = z.object({
  kind: z.string().min(1).max(40),
});

export const PluginInstallSchema = z.object({
  url: z.string().min(1).max(2000),
});

export const PluginUpdateSchema = z.object({
  enabled: z.boolean(),
  grantedPermissions: z.array(PermissionSchema).optional(),
});

export const PluginRunSchema = z.object({
  request: z.unknown().optional(),
});

/** v1: PUT /plugins/:id/settings — values validated per-field in the service. */
export const PluginSettingsPutSchema = z.object({
  values: z.record(z.string().max(64), z.unknown()),
});

/** v1: accept a plugin prep suggestion (re-validated against the contract). */
export const PluginSuggestionAcceptSchema = z.object({
  pluginId: z.string().min(1).max(120),
  activity: z.unknown(),
});
