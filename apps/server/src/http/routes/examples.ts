import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { listExamples, readExample } from "../../adapters/examples.js";

export const examplesRoutes = new Hono<AppEnv>();

examplesRoutes.get("/", async (c) =>
  c.json(await listExamples(c.var.examplesDir)),
);

examplesRoutes.get("/:name", async (c) => {
  const entry = await readExample(c.var.examplesDir, c.req.param("name"));
  if (!entry) {
    return c.json({ error: { code: "NOT_FOUND", message: "unknown example" } }, 404);
  }
  return c.json(entry);
});
