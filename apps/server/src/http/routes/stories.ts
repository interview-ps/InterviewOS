import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { streamOrJson } from "../middleware/stream.js";
import { parseBody } from "../middleware/validate.js";
import { StoryPatchSchema } from "../schemas.js";

export const storiesRoutes = new Hono<AppEnv>();

storiesRoutes.get("/", async (c) => c.json(await c.var.orchestrator.listStories()));

storiesRoutes.post("/generate", async (c) => {
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.generateStories({ onProgress }),
  );
});

storiesRoutes.patch("/:id", async (c) => {
  const body = await parseBody(c, StoryPatchSchema);
  return c.json(await c.var.orchestrator.updateStory(c.req.param("id"), body));
});

storiesRoutes.post("/:id/coach", async (c) => {
  const id = c.req.param("id");
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.coachStory(id, { onProgress }),
  );
});
