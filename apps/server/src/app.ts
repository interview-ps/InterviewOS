import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InterviewOrchestrator } from "@interview-os/orchestrator";
import type { AIRuntime } from "@interview-os/runtime";
import { RuntimeError } from "@interview-os/runtime";
import { AppError } from "@interview-os/shared";
import { SkillRuntimeError, SkillOutputError } from "@interview-os/skills";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export interface AppDeps {
  orchestrator: InterviewOrchestrator;
  runtime: AIRuntime;
  examplesDir?: string;
}

const SetupSchema = z.object({
  resumeText: z.string().min(1).max(190_000),
  jobDescription: z.string().min(1).max(190_000),
  company: z.string().min(1),
  role: z.string().min(1),
  level: z.enum(["junior", "mid", "senior", "staff"]),
});
const ResumeSchema = z.object({ resumeText: z.string().min(1).max(190_000) });
const JobSchema = SetupSchema.omit({ resumeText: true });
const InterviewCreateSchema = z.object({
  plannedQuestions: z.number().int().positive().max(20).optional(),
});
const AnswerSchema = z.object({ answer: z.string().min(1).max(190_000) });
const ActionPatchSchema = z.object({
  status: z.enum(["open", "in_progress", "done", "superseded"]),
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

export function createApp(deps: AppDeps) {
  const { orchestrator, runtime } = deps;
  const examplesDir = deps.examplesDir ?? path.join(REPO_ROOT, "examples");
  const app = new Hono();

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 200 * 1024,
      onError: (c) =>
        c.json({ error: { code: "TOO_LARGE", message: "body exceeds 200KB" } }, 413),
    }),
  );

  app.onError((err, c) => {
    const mapped = errorStatus(err);
    return c.json(
      { error: { code: mapped.code, message: mapped.message } },
      mapped.status as 400,
    );
  });

  app.get("/api/state", async (c) => c.json(await orchestrator.getState()));

  app.post("/api/workspace/setup", async (c) =>
    c.json(await orchestrator.setupWorkspace(await parseBody(c, SetupSchema))),
  );

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
    return c.json(await orchestrator.startInterview(body));
  });

  app.get("/api/interviews", (c) => c.json(orchestrator.listInterviews()));

  app.get("/api/interviews/:id", (c) =>
    c.json(orchestrator.getInterview(c.req.param("id"))),
  );

  app.post("/api/interviews/:id/answer", async (c) => {
    const { answer } = await parseBody(c, AnswerSchema);
    return c.json(await orchestrator.submitAnswer(c.req.param("id"), answer));
  });

  app.post("/api/interviews/:id/next", async (c) =>
    c.json(await orchestrator.nextQuestion(c.req.param("id"))),
  );

  app.post("/api/interviews/:id/complete", async (c) =>
    c.json(await orchestrator.completeInterview(c.req.param("id"))),
  );

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
      const [resumeText, jobDescription, metaRaw] = await Promise.all([
        fs.readFile(path.join(dir, "resume.md"), "utf8"),
        fs.readFile(path.join(dir, "job.md"), "utf8"),
        fs.readFile(path.join(dir, "meta.json"), "utf8"),
      ]);
      const meta = JSON.parse(metaRaw) as { company: string; role: string; level: string };
      return c.json({ name, resumeText, jobDescription, ...meta });
    } catch {
      return c.json({ error: { code: "NOT_FOUND", message: "unknown example" } }, 404);
    }
  });

  return app;
}
