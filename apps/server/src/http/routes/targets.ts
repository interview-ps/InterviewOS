import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { streamOrJson } from "../middleware/stream.js";
import { parseBody } from "../middleware/validate.js";
import { TargetCreateSchema, TargetPatchSchema } from "../schemas.js";

export const targetsRoutes = new Hono<AppEnv>();

targetsRoutes.get("/", async (c) => c.json(await c.var.orchestrator.listTargets()));

targetsRoutes.post("/", async (c) => {
  const body = await parseBody(c, TargetCreateSchema);
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.addTarget(body, { onProgress }),
  );
});

targetsRoutes.post("/:id/activate", async (c) =>
  c.json(await c.var.orchestrator.activateTarget(c.req.param("id"))),
);

// §9.3: switch the target's company profile; boosts recompute from base.
targetsRoutes.patch("/:id", async (c) => {
  const { companyProfileId } = await parseBody(c, TargetPatchSchema);
  return c.json(
    await c.var.orchestrator.updateTargetCompanyProfile(c.req.param("id"), companyProfileId),
  );
});
