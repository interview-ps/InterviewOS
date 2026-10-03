import { Hono } from "hono";
import type { AppEnv } from "../context.js";

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.get("/", (c) =>
  c.json({
    skills: c.var.orchestrator.listSkillManifests(),
    pluginErrors: c.var.pluginErrors,
  }),
);
