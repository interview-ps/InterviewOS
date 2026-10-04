import { Hono } from "hono";
import type { AppEnv } from "../context.js";

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.get("/", async (c) => {
  const manifests = c.var.orchestrator.listSkillManifests();
  const plugins = await c.var.orchestrator.listPlugins();
  const pluginState = new Map(
    plugins.map((p) => [p.manifest.id, p] as const),
  );
  return c.json({
    skills: manifests.map((m) => ({
      ...m,
      compatible: pluginState.get(m.id)?.compatible ?? true,
    })),
    pluginErrors: c.var.pluginErrors,
  });
});
