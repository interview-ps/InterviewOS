import path from "node:path";
import { serve } from "@hono/node-server";
import { openStore, InterviewOrchestrator } from "@interview-os/orchestrator";
import { createRuntime, MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { registerMockHandlers } from "@interview-os/skills";
import { createApp, REPO_ROOT } from "./app.js";
import { loadPlugins } from "./plugins.js";

const logger = createLogger({ level: "info", service: "server" });

const dbPath = process.env.INTERVIEW_OS_DB ?? path.join(REPO_ROOT, "data/interview-os.db");
const workspaceDir =
  process.env.INTERVIEW_OS_CODEX_WORKSPACE ?? path.join(REPO_ROOT, "data/codex-workspace");
const port = Number(process.env.INTERVIEW_OS_PORT ?? 4100);

const store = openStore(dbPath);
const runtime = await createRuntime({ env: process.env, workspaceDir, logger });
if (runtime.kind === "mock") {
  registerMockHandlers(runtime as MockRuntime);
}

const orchestrator = new InterviewOrchestrator({ store, runtime, logger });

// §9.6: discover local plugins (default <repo>/plugins) before serving.
const pluginsDir =
  process.env.INTERVIEW_OS_PLUGINS_DIR ?? path.join(REPO_ROOT, "plugins");
const pluginErrors = await loadPlugins(pluginsDir, orchestrator, logger);

const app = createApp({ orchestrator, runtime, logger, pluginErrors });

serve({ fetch: app.fetch, port }, (info) => {
  logger.info("server.listening", {
    port: info.port,
    runtime: runtime.kind,
    db: path.basename(dbPath),
  });
});
