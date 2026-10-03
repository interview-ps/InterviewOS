import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InterviewOrchestrator, Store } from "@interview-os/orchestrator";
import type { AIRuntime, RuntimeManager } from "@interview-os/runtime";
import { RUNTIME_KINDS, RuntimeError } from "@interview-os/runtime";
import { AppError, createLogger, type Logger } from "@interview-os/shared";
import { RoundTypeSchema, SkillIdSchema, MODE_IDS } from "@interview-os/core";
import {
  SkillRuntimeError,
  SkillOutputError,
  type ProgressUpdate,
} from "@interview-os/skills";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { extractDocument } from "./documents.js";
import type { PluginLoadError } from "./plugins.js";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export interface AppDeps {
  orchestrator: InterviewOrchestrator;
  runtime: AIRuntime;
  /** When present, enables runtime probing (`GET /api/runtime/available`) and
   * hot-switching (`PUT /api/runtime`); `store` persists the selection. */
  runtimes?: RuntimeManager;
  store?: Store;
  examplesDir?: string;
  logger?: Logger;
  /** §9.6: plugin directories that failed validation/import at startup. */
  pluginErrors?: PluginLoadError[];
}

const SetupSchema = z.object({
  resumeText: z.string().min(1).max(190_000),
  jobDescription: z.string().min(1).max(190_000),
  company: z.string().min(1),
  role: z.string().min(1),
  level: z.enum(["junior", "mid", "senior", "staff"]),
  companyNotes: z.string().max(50_000).optional(),
});
const ResumeSchema = z.object({ resumeText: z.string().min(1).max(190_000) });
const JobSchema = SetupSchema.omit({ resumeText: true });
const InterviewCreateSchema = z.object({
  plannedQuestions: z.number().int().positive().max(20).optional(),
  // "interview"|"practice" = session mode (v0.2); a §9.1 ModeId also accepted
  mode: z.string().max(32).optional(),
  focusSkillId: SkillIdSchema.optional(),
  actionId: z.string().min(1).optional(),
  roundType: RoundTypeSchema.optional(),
});
const StoryPatchSchema = z.object({
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
const AnswerSchema = z.object({
  answer: z.string().min(1).max(190_000),
  /** §9.1: optional code submission, ≤ 50 KB, reviewed but not executed. */
  code: z.string().max(50 * 1024).optional(),
  language: z.enum(CODE_LANGUAGES).optional(),
});
const ActionPatchSchema = z.object({
  status: z.enum(["open", "in_progress", "done", "superseded"]),
});
const ActionCompleteSchema = z.object({
  checkedCriteria: z.array(z.string()).optional(),
});
const TargetCreateSchema = z.object({
  jobDescription: z.string().min(1).max(190_000),
  company: z.string().min(1),
  role: z.string().min(1),
  level: z.enum(["junior", "mid", "senior", "staff"]),
  companyNotes: z.string().max(50_000).optional(),
});
const TargetPatchSchema = z.object({
  companyProfileId: z.string().min(1).max(64),
});
const LoopCreateSchema = z.object({
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
const UsageEventSchema = z.object({ event: z.string().min(1).max(64) });
const SettingsSchema = z.object({
  model: z.string().max(128).nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
  taskMode: z.enum(["app-server", "exec"]).optional(),
});
const RuntimeSwitchSchema = z.object({ kind: z.enum(RUNTIME_KINDS) });

async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("VALIDATION", "request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION",
      `invalid request body: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function errorStatus(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof SkillRuntimeError) {
    if (err.runtimeCode === "UNAVAILABLE") {
      return { status: 503, code: "UNAVAILABLE", message: err.message };
    }
    if (err.runtimeCode === "TIMEOUT") {
      return {
        status: 504,
        code: "RUNTIME_TIMEOUT",
        message: `The AI runtime timed out while running "${err.taskId}". ${err.message}`,
      };
    }
    return {
      status: 502,
      code: "RUNTIME_FAILED",
      message: `The AI runtime failed while running "${err.taskId}". ${err.message}`,
    };
  }
  if (err instanceof RuntimeError && err.code === "UNAVAILABLE") {
    return { status: 503, code: "UNAVAILABLE", message: err.message };
  }
  if (err instanceof RuntimeError) {
    if (err.code === "TIMEOUT") {
      return { status: 504, code: "RUNTIME_TIMEOUT", message: err.message };
    }
    return { status: 502, code: "RUNTIME_FAILED", message: err.message };
  }
  if (err instanceof SkillOutputError) {
    return { status: 502, code: err.code, message: err.message };
  }
  if (err instanceof AppError) {
    if (err.code === "INVALID_TRANSITION")
      return { status: 409, code: err.code, message: err.message };
    if (err.code === "NOT_FOUND")
      return { status: 404, code: err.code, message: err.message };
    if (err.code === "NO_ACTIVE_PROFILE")
      return { status: 409, code: err.code, message: err.message };
    if (err.code === "UNSUPPORTED_FORMAT")
      return { status: 415, code: err.code, message: err.message };
    if (err.code === "EXTRACTION_FAILED")
      return { status: 422, code: err.code, message: err.message };
    if (err.code === "VALIDATION")
      return { status: 400, code: err.code, message: err.message };
    return { status: 400, code: err.code, message: err.message };
  }
  return {
    status: 500,
    code: "INTERNAL",
    message: err instanceof Error ? err.message : String(err),
  };
}

function wantsStream(c: Context): boolean {
  return (
    c.req.query("stream") === "1" ||
    (c.req.header("accept") ?? "").includes("text/event-stream")
  );
}

/**
 * Run an orchestrator operation with SSE progress when the client asked for it
 * (Accept: text/event-stream or ?stream=1). Events: `stage {name}`,
 * `delta {field, text}`, `result <same JSON as non-stream>`,
 * `error {code, message}` (HTTP stays 200 once streaming started). A client
 * disconnect never aborts the operation — writes just stop landing.
 */
function streamOrJson<T>(
  c: Context,
  run: (onProgress: (p: ProgressUpdate) => void) => Promise<T>,
): Response | Promise<Response> {
  if (!wantsStream(c)) {
    return run(() => {}).then((r) => c.json(r));
  }
  return streamSSE(c, async (stream) => {
    // serialize writes — progress callbacks can't await
    let chain = Promise.resolve();
    const enqueue = (event: string, data: unknown) => {
      chain = chain
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .catch(() => {});
    };
    // heartbeat while the operation runs: keeps dev proxies flushing (the
    // Next.js rewrite proxy otherwise intermittently holds the tail bytes)
    // and gives clients a liveness signal during long silent stretches.
    const heartbeat = setInterval(() => enqueue("ping", {}), 10_000);
    try {
      const result = await run((p) => {
        if ("stage" in p) enqueue("stage", { name: p.stage });
        else enqueue("delta", { field: p.field, text: p.text });
      });
      await chain;
      await stream
        .writeSSE({ event: "result", data: JSON.stringify(result) })
        .catch(() => {});
    } catch (err) {
      const mapped = errorStatus(err);
      await chain;
      await stream
        .writeSSE({
          event: "error",
          data: JSON.stringify({ code: mapped.code, message: mapped.message }),
        })
        .catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  });
}

export function createApp(deps: AppDeps) {
  const { orchestrator, runtime, runtimes, store } = deps;
  const logger = deps.logger ?? createLogger({ level: "error", sink: () => {} });
  const examplesDir = deps.examplesDir ?? path.join(REPO_ROOT, "examples");
  const app = new Hono();

  const apiBodyLimit = bodyLimit({
    maxSize: 200 * 1024,
    onError: (c) =>
      c.json({ error: { code: "TOO_LARGE", message: "body exceeds 200KB" } }, 413),
  });
  const docBodyLimit = bodyLimit({
    maxSize: 5 * 1024 * 1024,
    onError: (c) =>
      c.json({ error: { code: "TOO_LARGE", message: "file exceeds 5MB" } }, 413),
  });
  app.use("/api/*", (c, next) =>
    c.req.path === "/api/documents/extract" ? docBodyLimit(c, next) : apiBodyLimit(c, next),
  );

  app.onError((err, c) => {
    const mapped = errorStatus(err);
    return c.json(
      { error: { code: mapped.code, message: mapped.message } },
      mapped.status as 400,
    );
  });

  app.get("/api/state", async (c) => c.json(await orchestrator.getState()));

  // test-mode only: reset endpoint for e2e isolation — 404 unless enabled
  app.post("/api/test/reset", (c) => {
    if (process.env.INTERVIEW_OS_TEST_MODE !== "1") return c.notFound();
    orchestrator.resetAll();
    return c.json({ ok: true });
  });

  app.post("/api/workspace/setup", async (c) => {
    const body = await parseBody(c, SetupSchema);
    return streamOrJson(c, (onProgress) =>
      orchestrator.setupWorkspace(body, { onProgress }),
    );
  });

  app.post("/api/analysis/resume", async (c) =>
    c.json(await orchestrator.analyzeCandidate((await parseBody(c, ResumeSchema)).resumeText)),
  );

  app.post("/api/analysis/job", async (c) =>
    c.json(await orchestrator.analyzeTarget(await parseBody(c, JobSchema))),
  );

  app.post("/api/analysis/gaps", async (c) => c.json(await orchestrator.calculateGaps()));

  app.get("/api/preparation", async (c) => {
    const state = await orchestrator.getState();
    return c.json({
      nextActions: state.preparation.nextActions,
      actions: orchestrator.listPreparationActions(),
    });
  });

  app.post("/api/preparation/recalculate", async (c) =>
    c.json(await orchestrator.buildPreparationPlan()),
  );

  app.patch("/api/preparation/:id", async (c) => {
    const { status } = await parseBody(c, ActionPatchSchema);
    await orchestrator.updateActionStatus(c.req.param("id"), status);
    return c.json({ ok: true });
  });

  app.post("/api/preparation/:id/complete", async (c) => {
    let body: z.infer<typeof ActionCompleteSchema> = {};
    const text = await c.req.text();
    if (text.trim() !== "") {
      try {
        const parsed = ActionCompleteSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error();
        body = parsed.data;
      } catch {
        throw new AppError("VALIDATION", "invalid request body");
      }
    }
    return c.json(await orchestrator.completeAction(c.req.param("id"), body));
  });

  app.get("/api/targets", (c) => c.json(orchestrator.listTargets()));

  app.post("/api/targets", async (c) => {
    const body = await parseBody(c, TargetCreateSchema);
    return streamOrJson(c, (onProgress) =>
      orchestrator.addTarget(body, { onProgress }),
    );
  });

  app.post("/api/targets/:id/activate", async (c) =>
    c.json(await orchestrator.activateTarget(c.req.param("id"))),
  );

  // §9.3: switch the target's company profile; boosts recompute from base.
  app.patch("/api/targets/:id", async (c) => {
    const { companyProfileId } = await parseBody(c, TargetPatchSchema);
    return c.json(
      await orchestrator.updateTargetCompanyProfile(c.req.param("id"), companyProfileId),
    );
  });

  // §9.3: built-in company profiles (each carries its disclaimer).
  app.get("/api/companies", (c) => c.json(orchestrator.listCompanyProfiles()));

  app.post("/api/documents/extract", async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      throw new AppError("VALIDATION", "multipart field 'file' is required");
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await extractDocument(buf, file.name);
    // lengths only — never log document contents
    logger.info("document.extracted", {
      nameLength: file.name.length,
      bytes: buf.length,
      format: result.format,
      chars: result.text.length,
    });
    return c.json(result);
  });

  app.post("/api/interviews", async (c) => {
    let body: z.infer<typeof InterviewCreateSchema> = {};
    const text = await c.req.text();
    if (text.trim() !== "") {
      try {
        body = InterviewCreateSchema.parse(JSON.parse(text));
      } catch {
        throw new AppError("VALIDATION", "invalid request body");
      }
    }
    // §9.1: `mode` accepts a ModeId (alias for roundType) or the v0.2
    // session mode ("interview" | "practice").
    let sessionMode: "interview" | "practice" | undefined;
    let roundType = body.roundType;
    if (body.mode !== undefined) {
      if (body.mode === "interview" || body.mode === "practice") {
        sessionMode = body.mode;
      } else if (
        body.mode === "mixed" ||
        (MODE_IDS as readonly string[]).includes(body.mode)
      ) {
        roundType = RoundTypeSchema.parse(body.mode);
      } else {
        throw new AppError("VALIDATION", `unknown interview mode "${body.mode}"`);
      }
    }
    return streamOrJson(c, (onProgress) =>
      orchestrator.startInterview(
        { ...body, mode: sessionMode, roundType },
        { onProgress },
      ),
    );
  });

  app.get("/api/stories", (c) => c.json(orchestrator.listStories()));

  app.post("/api/stories/generate", async (c) => {
    return streamOrJson(c, (onProgress) =>
      orchestrator.generateStories({ onProgress }),
    );
  });

  app.patch("/api/stories/:id", async (c) => {
    const body = await parseBody(c, StoryPatchSchema);
    return c.json(await orchestrator.updateStory(c.req.param("id"), body));
  });

  app.post("/api/stories/:id/coach", async (c) => {
    const id = c.req.param("id");
    return streamOrJson(c, (onProgress) =>
      orchestrator.coachStory(id, { onProgress }),
    );
  });

  app.get("/api/interviews", (c) => c.json(orchestrator.listInterviews()));

  app.get("/api/interviews/:id", (c) =>
    c.json(orchestrator.getInterview(c.req.param("id"))),
  );

  app.post("/api/interviews/:id/answer", async (c) => {
    const { answer, code, language } = await parseBody(c, AnswerSchema);
    const id = c.req.param("id");
    return streamOrJson(c, (onProgress) =>
      orchestrator.submitAnswer(id, { text: answer, code, language }, { onProgress }),
    );
  });

  app.post("/api/interviews/:id/next", async (c) => {
    const id = c.req.param("id");
    return streamOrJson(c, (onProgress) =>
      orchestrator.nextQuestion(id, { onProgress }),
    );
  });

  app.post("/api/interviews/:id/complete", async (c) => {
    const id = c.req.param("id");
    return streamOrJson(c, (onProgress) =>
      orchestrator.completeInterview(id, { onProgress }),
    );
  });

  app.get("/api/interviews/:id/debrief", (c) => {
    const interview = orchestrator.getInterview(c.req.param("id"));
    if (!interview.debrief) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "no debrief for this session" } },
        404,
      );
    }
    return c.json(interview.debrief);
  });

  // --- §9.4 interview loops ------------------------------------------------

  app.post("/api/loops", async (c) => {
    const body = await parseBody(c, LoopCreateSchema);
    return streamOrJson(c, (onProgress) =>
      orchestrator.startLoop(body, { onProgress }),
    );
  });

  app.get("/api/loops", (c) => c.json(orchestrator.listLoops()));

  app.get("/api/loops/:id", (c) => c.json(orchestrator.getLoop(c.req.param("id"))));

  app.post("/api/loops/:id/abandon", async (c) =>
    c.json(await orchestrator.abandonLoop(c.req.param("id"))),
  );

  // --- §9.7 history / metrics / usage events --------------------------------

  app.get("/api/history", (c) =>
    c.json(
      orchestrator.getHistory({
        mode: c.req.query("mode") || undefined,
        targetId: c.req.query("targetId") || undefined,
        loopId: c.req.query("loopId") || undefined,
        weakOnly: c.req.query("weakOnly") === "1" || c.req.query("weakOnly") === "true",
      }),
    ),
  );

  app.get("/api/history/:id", (c) => {
    orchestrator.recordUsageEvent("history.viewed");
    return c.json(orchestrator.getSessionHistory(c.req.param("id")));
  });

  // --- §9.5 resume coach ----------------------------------------------------

  app.post("/api/resume/review", async (c) => {
    return streamOrJson(c, (onProgress) =>
      orchestrator.reviewResume({ onProgress }),
    );
  });

  app.get("/api/resume/reviews/latest", (c) =>
    c.json(orchestrator.latestResumeReview()),
  );

  // --- §9.6 skills & plugins ------------------------------------------------

  app.get("/api/skills", (c) =>
    c.json({
      skills: orchestrator.listSkillManifests(),
      pluginErrors: deps.pluginErrors ?? [],
    }),
  );

  app.post("/api/plugins/:id/run", async (c) =>
    c.json({ output: await orchestrator.runPlugin(c.req.param("id")) }),
  );

  app.post("/api/events", async (c) => {
    const { event } = await parseBody(c, UsageEventSchema);
    orchestrator.recordUsageEvent(event);
    return c.json({ ok: true });
  });

  app.get("/api/metrics", (c) => c.json(orchestrator.getMetrics()));

  app.get("/api/readiness", async (c) => {
    const state = await orchestrator.getState();
    return c.json(state.readiness);
  });

  app.get("/api/readiness/:skillId", async (c) =>
    c.json(await orchestrator.getSkillDetail(c.req.param("skillId"))),
  );

  app.get("/api/settings", (c) => c.json(orchestrator.getSettings()));

  app.put("/api/settings", async (c) =>
    c.json(await orchestrator.updateSettings(await parseBody(c, SettingsSchema))),
  );

  app.get("/api/runtime/models", async (c) => c.json(await runtime.listModels()));

  app.get("/api/runtime/status", async (c) => {
    const status = await runtime.healthCheck();
    return c.json({ ...status, mode: runtime.kind });
  });

  app.post("/api/runtime/check", async (c) => {
    const status = await runtime.healthCheck();
    return c.json({ ...status, mode: runtime.kind });
  });

  app.get("/api/runtime/available", async (c) => {
    const providers = runtimes ? await runtimes.probeAll() : [];
    return c.json({ active: runtime.kind, providers });
  });

  app.put("/api/runtime", async (c) => {
    if (!runtimes) {
      throw new AppError(
        "VALIDATION",
        "runtime switching is not enabled on this server",
      );
    }
    const { kind } = await parseBody(c, RuntimeSwitchSchema);
    const status = await runtimes.switchTo(kind);
    store?.setSetting("runtimeKind", runtimes.kind);
    // Re-resolve the saved model against the new provider's catalog so a stale
    // id falls back to that provider's default instead of erroring later.
    const current = orchestrator.getSettings();
    if (current.model) {
      await orchestrator.updateSettings({ model: current.model });
    }
    return c.json({ ...status, mode: runtimes.kind });
  });

  app.get("/api/examples", async (c) => {
    const entries = await fs.readdir(examplesDir, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return c.json(names);
  });

  app.get("/api/examples/:name", async (c) => {
    const name = c.req.param("name");
    if (!/^[a-z0-9-]+$/.test(name)) {
      return c.json({ error: { code: "NOT_FOUND", message: "unknown example" } }, 404);
    }
    try {
      const dir = path.join(examplesDir, name);
      const [resumeText, jobDescription, metaRaw, companyNotes] = await Promise.all([
        fs.readFile(path.join(dir, "resume.md"), "utf8"),
        fs.readFile(path.join(dir, "job.md"), "utf8"),
        fs.readFile(path.join(dir, "meta.json"), "utf8"),
        fs.readFile(path.join(dir, "company.md"), "utf8").catch(() => ""),
      ]);
      const meta = JSON.parse(metaRaw) as { company: string; role: string; level: string };
      return c.json({
        name,
        resumeText,
        jobDescription,
        companyNotes: companyNotes || undefined,
        ...meta,
      });
    } catch {
      return c.json({ error: { code: "NOT_FOUND", message: "unknown example" } }, 404);
    }
  });

  return app;
}
