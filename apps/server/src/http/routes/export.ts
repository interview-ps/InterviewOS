import { Hono } from "hono";
import type { ExportPart } from "@interview-os/core";
import type { AppEnv } from "../context.js";
import { parseBody } from "../middleware/validate.js";
import { ImportSchema } from "../schemas.js";

/** v0.4 export/import — attachments, thin over the orchestrator. */
export const exportRoutes = new Hono<AppEnv>();

exportRoutes.get("/export", async (c) => {
  const bundle = await c.var.orchestrator.exportState();
  const date = new Date().toISOString().slice(0, 10);
  c.header("content-disposition", `attachment; filename="interview-os-export-${date}.json"`);
  return c.json(bundle);
});

exportRoutes.get("/export/:part", async (c) => {
  const part = c.req.param("part") as ExportPart;
  const slice = await c.var.orchestrator.exportStatePart(part);
  c.header("content-disposition", `attachment; filename="${part}.json"`);
  return c.json(slice);
});

exportRoutes.post("/import", async (c) => {
  const body = await parseBody(c, ImportSchema);
  const counts = await c.var.orchestrator.importState(body.bundle, {
    mode: body.confirm,
  });
  return c.json({ ok: true, counts });
});
