import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { streamOrJson } from "../middleware/stream.js";
import { parseBody } from "../middleware/validate.js";
import { InterviewPackCreateSchema, InterviewPackImportSchema } from "../schemas.js";

export const interviewPacksRoutes = new Hono<AppEnv>();

interviewPacksRoutes.get("/", async (c) =>
  c.json(await c.var.orchestrator.listInterviewPacks()),
);

interviewPacksRoutes.post("/", async (c) => {
  const body = await parseBody(c, InterviewPackCreateSchema);
  return c.json(await c.var.orchestrator.createInterviewPack(body), 201);
});

interviewPacksRoutes.post("/import", async (c) => {
  const body = await parseBody(c, InterviewPackImportSchema);
  return c.json(await c.var.orchestrator.importInterviewPack(body.content), 201);
});

interviewPacksRoutes.delete("/:id", async (c) => {
  await c.var.orchestrator.deleteInterviewPack(c.req.param("id"));
  return c.json({ ok: true });
});

interviewPacksRoutes.get("/:id/export", async (c) => {
  const { filename, content } = await c.var.orchestrator.exportInterviewPack(
    c.req.param("id"),
  );
  c.header("content-disposition", `attachment; filename="${filename}"`);
  c.header("content-type", "application/yaml; charset=utf-8");
  return c.body(content);
});

interviewPacksRoutes.post("/:id/start", async (c) =>
  streamOrJson(c, (onProgress) =>
    c.var.orchestrator.startLoopFromPack(c.req.param("id"), { onProgress }),
  ),
);
