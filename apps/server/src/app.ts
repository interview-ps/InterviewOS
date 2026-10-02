import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InterviewOrchestrator } from "@interview-os/orchestrator";
import type { AIRuntime } from "@interview-os/runtime";
import { RuntimeError } from "@interview-os/runtime";
import { AppError, createLogger, type Logger } from "@interview-os/shared";
import { RoundTypeSchema, SkillIdSchema } from "@interview-os/core";
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

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export interface AppDeps {
  orchestrator: InterviewOrchestrator;
  runtime: AIRuntime;
  examplesDir?: string;
  logger?: Logger;
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
  mode: z.enum(["interview", "practice"]).optional(),
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
const AnswerSchema = z.object({ answer: z.string().min(1).max(190_000) });
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
const SettingsSchema = z.object({
  codexModel: z.string().max(64).nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
  taskMode: z.enum(["app-server", "exec"]).optional(),
});

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
  if (err instanceof SkillRuntimeError && err.runtimeCode === "UNAVAILABLE") {
    return { status: 503, code: "UNAVAILABLE", message: err.message };
  }
  if (err instanceof RuntimeError && err.code === "UNAVAILABLE") {
    return { status: 503, code: "UNAVAILABLE", message: err.message };
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
    }
  });
}

export function createApp(deps: AppDeps) {
  const { orchestrator, runtime } = deps;
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
    return streamOrJson(c, (onProgress) =>
      orchestrator.startInterview(body, { onProgress }),
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
    const { answer } = await parseBody(c, AnswerSchema);
    const id = c.req.param("id");
    return streamOrJson(c, (onProgress) =>
      orchestrator.submitAnswer(id, answer, { onProgress }),
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
