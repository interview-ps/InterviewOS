import { createLogger } from "@interview-os/core";
import { Hono } from "hono";
import { DEFAULT_EXAMPLES_DIR } from "../paths.js";
import type { AppDeps, AppEnv } from "./context.js";
import { apiBodyLimit, docBodyLimit } from "./middleware/body-limit.js";
import { onError } from "./middleware/error.js";
import { companiesRoutes } from "./routes/companies.js";
import { documentsRoutes } from "./routes/documents.js";
import { examplesRoutes } from "./routes/examples.js";
import { historyRoutes } from "./routes/history.js";
import { interviewsRoutes } from "./routes/interviews.js";
import { loopsRoutes } from "./routes/loops.js";
import { preparationRoutes } from "./routes/preparation.js";
import { readinessRoutes } from "./routes/readiness.js";
import { resumeRoutes } from "./routes/resume.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { settingsRoutes } from "./routes/settings.js";
import { pluginsRoutes } from "./routes/plugins.js";
import { skillsRoutes } from "./routes/skills.js";
import { storiesRoutes } from "./routes/stories.js";
import { targetsRoutes } from "./routes/targets.js";
import { usageRoutes } from "./routes/usage.js";
import { workspaceRoutes } from "./routes/workspace.js";

export type { AppDeps } from "./context.js";

export function createApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger({ level: "error", sink: () => {} });
  const examplesDir = deps.examplesDir ?? DEFAULT_EXAMPLES_DIR;
  const app = new Hono<AppEnv>();

  app.use("/api/*", (c, next) =>
    c.req.path === "/api/documents/extract"
      ? docBodyLimit(c, next)
      : apiBodyLimit(c, next),
  );

  // Resolve dependencies once per request; handlers read them via c.var.
  app.use("/api/*", async (c, next) => {
    c.set("orchestrator", deps.orchestrator);
    c.set("runtime", deps.runtime);
    c.set("runtimes", deps.runtimes);
    c.set("store", deps.store);
    c.set("logger", logger);
    c.set("examplesDir", examplesDir);
    c.set("pluginErrors", deps.pluginErrors ?? []);
    await next();
  });

  app.onError(onError);

  app.route("/api", workspaceRoutes);
  app.route("/api", usageRoutes);
  app.route("/api/preparation", preparationRoutes);
  app.route("/api/targets", targetsRoutes);
  app.route("/api/companies", companiesRoutes);
  app.route("/api/interviews", interviewsRoutes);
  app.route("/api/stories", storiesRoutes);
  app.route("/api/loops", loopsRoutes);
  app.route("/api/history", historyRoutes);
  app.route("/api/resume", resumeRoutes);
  app.route("/api/readiness", readinessRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/runtime", runtimeRoutes);
  app.route("/api/skills", skillsRoutes);
  app.route("/api/plugins", pluginsRoutes);
  app.route("/api/documents", documentsRoutes);
  app.route("/api/examples", examplesRoutes);

  return app;
}
