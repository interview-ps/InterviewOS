import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { parseBody, parseOptionalBody } from "../middleware/validate.js";
import {
  ActionCompleteSchema,
  ActionPatchSchema,
  PluginSuggestionAcceptSchema,
} from "../schemas.js";

export const preparationRoutes = new Hono<AppEnv>();

preparationRoutes.get("/", async (c) => {
  const state = await c.var.orchestrator.getState();
  return c.json({
    nextActions: state.preparation.nextActions,
    actions: await c.var.orchestrator.listPreparationActions(),
  });
});

preparationRoutes.post("/recalculate", async (c) =>
  c.json(await c.var.orchestrator.buildPreparationPlan()),
);

/* ------------------------------------------------ v1 plugin suggestions -- */

/** Plugin-suggested prep activities with attribution (read-only). */
preparationRoutes.get("/suggestions", async (c) =>
  c.json({ suggestions: await c.var.orchestrator.pluginPrepSuggestions() }),
);

/** Accept a suggestion → prep action `source: "plugin:<id>"`. */
preparationRoutes.post("/suggestions/accept", async (c) => {
  const body = await parseBody(c, PluginSuggestionAcceptSchema);
  return c.json(
    await c.var.orchestrator.acceptPluginSuggestion(
      body.pluginId,
      body.activity,
    ),
  );
});

preparationRoutes.patch("/:id", async (c) => {
  const { status } = await parseBody(c, ActionPatchSchema);
  await c.var.orchestrator.updateActionStatus(c.req.param("id"), status);
  return c.json({ ok: true });
});

preparationRoutes.post("/:id/complete", async (c) => {
  const body = (await parseOptionalBody(c, ActionCompleteSchema)) ?? {};
  return c.json(await c.var.orchestrator.completeAction(c.req.param("id"), body));
});

// v0.4: pull learning resources for an action from enabled `resources` plugins.
preparationRoutes.post("/:id/resources", async (c) =>
  c.json(await c.var.orchestrator.fetchPluginResources(c.req.param("id"))),
);
