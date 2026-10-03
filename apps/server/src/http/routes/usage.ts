import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { parseBody } from "../middleware/validate.js";
import { UsageEventSchema } from "../schemas.js";

export const usageRoutes = new Hono<AppEnv>();

usageRoutes.post("/events", async (c) => {
  const { event } = await parseBody(c, UsageEventSchema);
  await c.var.orchestrator.recordUsageEvent(event);
  return c.json({ ok: true });
});

usageRoutes.get("/metrics", async (c) => c.json(await c.var.orchestrator.getMetrics()));
