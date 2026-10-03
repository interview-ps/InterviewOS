import { Hono } from "hono";
import type { AppEnv } from "../context.js";

export const readinessRoutes = new Hono<AppEnv>();

readinessRoutes.get("/", async (c) => {
  const state = await c.var.orchestrator.getState();
  return c.json(state.readiness);
});

readinessRoutes.get("/:skillId", async (c) =>
  c.json(await c.var.orchestrator.getSkillDetail(c.req.param("skillId"))),
);
