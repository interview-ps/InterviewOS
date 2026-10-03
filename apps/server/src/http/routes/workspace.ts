import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { streamOrJson } from "../middleware/stream.js";
import { parseBody } from "../middleware/validate.js";
import {
  JobSchema,
  ResumeSchema,
  SetupSchema,
} from "../schemas.js";

export const workspaceRoutes = new Hono<AppEnv>();

workspaceRoutes.post("/workspace/setup", async (c) => {
  const body = await parseBody(c, SetupSchema);
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.setupWorkspace(body, { onProgress }),
  );
});

workspaceRoutes.post("/analysis/resume", async (c) =>
  c.json(
    await c.var.orchestrator.analyzeCandidate((await parseBody(c, ResumeSchema)).resumeText),
  ),
);

workspaceRoutes.post("/analysis/job", async (c) =>
  c.json(await c.var.orchestrator.analyzeTarget(await parseBody(c, JobSchema))),
);

workspaceRoutes.post("/analysis/gaps", async (c) =>
  c.json(await c.var.orchestrator.calculateGaps()),
);

workspaceRoutes.get("/state", async (c) => c.json(await c.var.orchestrator.getState()));

// test-mode only: reset endpoint for e2e isolation — 404 unless enabled
workspaceRoutes.post("/test/reset", async (c) => {
  if (process.env.INTERVIEW_OS_TEST_MODE !== "1") return c.notFound();
  await c.var.orchestrator.resetAll();
  return c.json({ ok: true });
});
