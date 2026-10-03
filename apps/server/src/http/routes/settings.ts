import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { parseBody } from "../middleware/validate.js";
import { SettingsSchema } from "../schemas.js";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/", (c) => c.json(c.var.orchestrator.getSettings()));

settingsRoutes.put("/", async (c) =>
  c.json(await c.var.orchestrator.updateSettings(await parseBody(c, SettingsSchema))),
);
