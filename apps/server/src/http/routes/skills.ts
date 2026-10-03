import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { parseBody } from "../middleware/validate.js";
import { UsageEventSchema } from "../schemas.js";

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.get("/", (c) =>
  c.json({
    skills: c.var.orchestrator.listSkillManifests(),
    pluginErrors: c.var.pluginErrors,
  }),
);

skillsRoutes.post("/events", async (c) => {
  const { event } = await parseBody(c, UsageEventSchema);
  c.var.orchestrator.recordUsageEvent(event);
  return c.json({ ok: true });
});

skillsRoutes.get("/metrics", (c) => c.json(c.var.orchestrator.getMetrics()));
