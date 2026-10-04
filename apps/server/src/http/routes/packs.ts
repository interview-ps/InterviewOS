import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { parseBody } from "../middleware/validate.js";
import { PackInstallSchema } from "../schemas.js";

export const packsRoutes = new Hono<AppEnv>();

packsRoutes.get("/", async (c) => c.json(await c.var.orchestrator.listPacks()));

packsRoutes.post("/install", async (c) => {
  const body = await parseBody(c, PackInstallSchema);
  return c.json(await c.var.orchestrator.installPackFromGit(body.kind, body.url), 201);
});

packsRoutes.delete("/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  if (kind !== "company" && kind !== "role") {
    return c.json({ error: { code: "VALIDATION", message: "kind must be company or role" } }, 400);
  }
  await c.var.orchestrator.uninstallPack(kind, c.req.param("id"));
  return c.json({ ok: true });
});
