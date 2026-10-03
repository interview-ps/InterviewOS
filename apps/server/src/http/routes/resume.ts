import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { streamOrJson } from "../middleware/stream.js";

export const resumeRoutes = new Hono<AppEnv>();

resumeRoutes.post("/review", async (c) => {
  return streamOrJson(c, (onProgress) =>
    c.var.orchestrator.reviewResume({ onProgress }),
  );
});

resumeRoutes.get("/reviews/latest", (c) =>
  c.json(c.var.orchestrator.latestResumeReview()),
);
