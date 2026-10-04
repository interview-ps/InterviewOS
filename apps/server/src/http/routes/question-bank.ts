import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { parseBody } from "../middleware/validate.js";
import { QuestionBankAddSchema, QuestionBankImportSchema } from "../schemas.js";

export const questionBankRoutes = new Hono<AppEnv>();

questionBankRoutes.get("/", async (c) =>
  c.json(await c.var.orchestrator.listQuestionBank()),
);

questionBankRoutes.post("/", async (c) => {
  const body = await parseBody(c, QuestionBankAddSchema);
  return c.json(await c.var.orchestrator.addUserQuestion(body), 201);
});

questionBankRoutes.post("/import", async (c) => {
  const body = await parseBody(c, QuestionBankImportSchema);
  return c.json(await c.var.orchestrator.importQuestionBank(body.content), 201);
});

questionBankRoutes.delete("/:id", async (c) => {
  await c.var.orchestrator.deleteUserQuestion(c.req.param("id"));
  return c.json({ ok: true });
});
