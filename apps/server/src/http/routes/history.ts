import { Hono } from "hono";
import type { AppEnv } from "../context.js";

export const historyRoutes = new Hono<AppEnv>();

historyRoutes.get("/", async (c) =>
  c.json(
    await c.var.orchestrator.getHistory({
      mode: c.req.query("mode") || undefined,
      targetId: c.req.query("targetId") || undefined,
      loopId: c.req.query("loopId") || undefined,
      weakOnly: c.req.query("weakOnly") === "1" || c.req.query("weakOnly") === "true",
    }),
  ),
);

historyRoutes.get("/:id", async (c) => {
  await c.var.orchestrator.recordUsageEvent("history.viewed");
  return c.json(await c.var.orchestrator.getSessionHistory(c.req.param("id")));
});
