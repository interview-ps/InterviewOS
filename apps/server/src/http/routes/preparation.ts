import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { parseBody, parseOptionalBody } from "../middleware/validate.js";
import {
  ActionCompleteSchema,
  ActionPatchSchema,
} from "../schemas.js";

export const preparationRoutes = new Hono<AppEnv>();

preparationRoutes.get("/", async (c) => {
  const state = await c.var.orchestrator.getState();
  return c.json({
    nextActions: state.preparation.nextActions,
    actions: c.var.orchestrator.listPreparationActions(),
  });
});

preparationRoutes.post("/recalculate", async (c) =>
  c.json(await c.var.orchestrator.buildPreparationPlan()),
);

preparationRoutes.patch("/:id", async (c) => {
  const { status } = await parseBody(c, ActionPatchSchema);
  await c.var.orchestrator.updateActionStatus(c.req.param("id"), status);
  return c.json({ ok: true });
});

preparationRoutes.post("/:id/complete", async (c) => {
  const body = (await parseOptionalBody(c, ActionCompleteSchema)) ?? {};
  return c.json(await c.var.orchestrator.completeAction(c.req.param("id"), body));
});
