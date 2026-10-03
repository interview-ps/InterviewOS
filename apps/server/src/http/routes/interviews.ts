import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { streamOrJson } from "../middleware/stream.js";
import { parseBody, parseOptionalBody } from "../middleware/validate.js";
import { AnswerSchema, InterviewCreateSchema } from "../schemas.js";
import { RoundTypeSchema, MODE_IDS } from "@interview-os/core";
import { AppError } from "@interview-os/core";

export const interviewsRoutes = new Hono<AppEnv>();

interviewsRoutes.post("/", async (c) => {
  const body = (await parseOptionalBody(c, InterviewCreateSchema)) ?? {};
  // §9.1: `mode` accepts a ModeId (alias for roundType) or the v0.2
  // session mode ("interview" | "practice").
  let sessionMode: "interview" | "practice" | undefined;
  let roundType = body.roundType;
  if (body.mode !== undefined) {
    if (body.mode === "interview" || body.mode === "practice") {
      sessionMode = body.mode;
    } else if (
      body.mode === "mixed" ||
      (MODE_IDS as readonly string[]).includes(body.mode)
    ) {
      roundType = RoundTypeSchema.parse(body.mode);
    } else {
      throw new AppError("VALIDATION", `unknown interview mode "${body.mode}"`);
    }
  }
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.startInterview(
      { ...body, mode: sessionMode, roundType },
      { onProgress },
    ),
  );
});

interviewsRoutes.get("/", (c) => c.json(c.var.orchestrator.listInterviews()));

interviewsRoutes.get("/:id", (c) =>
  c.json(c.var.orchestrator.getInterview(c.req.param("id"))),
);

interviewsRoutes.post("/:id/answer", async (c) => {
  const { answer, code, language } = await parseBody(c, AnswerSchema);
  const id = c.req.param("id");
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.submitAnswer(id, { text: answer, code, language }, { onProgress }),
  );
});

interviewsRoutes.post("/:id/next", async (c) => {
  const id = c.req.param("id");
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.nextQuestion(id, { onProgress }),
  );
});

interviewsRoutes.post("/:id/complete", async (c) => {
  const id = c.req.param("id");
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.completeInterview(id, { onProgress }),
  );
});

interviewsRoutes.get("/:id/debrief", (c) => {
  const interview = c.var.orchestrator.getInterview(c.req.param("id"));
  if (!interview.debrief) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "no debrief for this session" } },
      404,
    );
  }
  return c.json(interview.debrief);
});
