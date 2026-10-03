import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { AppError } from "@interview-os/core";
import { parseBody } from "../middleware/validate.js";
import { RuntimeSwitchSchema } from "../schemas.js";

export const runtimeRoutes = new Hono<AppEnv>();

runtimeRoutes.get("/models", async (c) => c.json(await c.var.runtime.listModels()));

runtimeRoutes.get("/status", async (c) => {
  const status = await c.var.runtime.healthCheck();
  return c.json({ ...status, mode: c.var.runtime.kind });
});

runtimeRoutes.post("/check", async (c) => {
  const status = await c.var.runtime.healthCheck();
  return c.json({ ...status, mode: c.var.runtime.kind });
});

runtimeRoutes.get("/available", async (c) => {
  const runtimes = c.var.runtimes;
  const providers = runtimes ? await runtimes.probeAll() : [];
  return c.json({ active: c.var.runtime.kind, providers });
});

runtimeRoutes.put("/", async (c) => {
  const runtimes = c.var.runtimes;
  if (!runtimes) {
    throw new AppError(
      "VALIDATION",
      "runtime switching is not enabled on this server",
    );
  }
  const { kind } = await parseBody(c, RuntimeSwitchSchema);
  const status = await runtimes.switchTo(kind);
  c.var.store?.setSetting("runtimeKind", runtimes.kind);
  // Re-resolve the saved model against the new provider's catalog so a stale
  // id falls back to that provider's default instead of erroring later.
  const current = c.var.orchestrator.getSettings();
  if (current.model) {
    await c.var.orchestrator.updateSettings({ model: current.model });
  }
  return c.json({ ...status, mode: runtimes.kind });
});
