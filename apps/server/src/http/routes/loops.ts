import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { streamOrJson } from "../middleware/stream.js";
import { parseBody } from "../middleware/validate.js";
import { LoopCreateSchema } from "../schemas.js";

export const loopsRoutes = new Hono<AppEnv>();

loopsRoutes.post("/", async (c) => {
  const body = await parseBody(c, LoopCreateSchema);
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.startLoop(body, { onProgress }),
  );
});

loopsRoutes.get("/", (c) => c.json(c.var.orchestrator.listLoops()));

loopsRoutes.get("/:id", (c) => c.json(c.var.orchestrator.getLoop(c.req.param("id"))));

loopsRoutes.post("/:id/abandon", async (c) =>
  c.json(await c.var.orchestrator.abandonLoop(c.req.param("id"))),
);
