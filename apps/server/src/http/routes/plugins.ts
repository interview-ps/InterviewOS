import { Hono } from "hono";
import type { AppEnv } from "../context.js";

export const pluginsRoutes = new Hono<AppEnv>();

pluginsRoutes.post("/:id/run", async (c) =>
  c.json({ output: await c.var.orchestrator.runPlugin(c.req.param("id")) }),
);
