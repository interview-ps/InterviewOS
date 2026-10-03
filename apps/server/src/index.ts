import path from "node:path";
import { serve } from "@hono/node-server";
import { openStore, InterviewOrchestrator } from "@interview-os/orchestrator";
import { createRuntime, MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { registerMockHandlers } from "@interview-os/skills";
import { createApp } from "./http/app.js";
import { loadPlugins } from "./startup/plugins.js";
import { DEFAULT_DB_PATH, DEFAULT_PLUGINS_DIR } from "./paths.js";

const logger = createLogger({ level: "info", service: "server" });

const dbPath = process.env.INTERVIEW_OS_DB ?? DEFAULT_DB_PATH;
const port = Number(process.env.INTERVIEW_OS_PORT ?? 4100);

const store = openStore(dbPath);
// Saved UI selection wins only when INTERVIEW_OS_RUNTIME is unset.
const runtime = await createRuntime({
  env: process.env,
  logger,
  preferredKind: store.getSetting("runtimeKind"),
  onSwitch: (rt) => {
    if (rt instanceof MockRuntime) registerMockHandlers(rt);
  },
});

const orchestrator = new InterviewOrchestrator({ store, runtime, logger });

// §9.6: discover local plugins (default <repo>/plugins) before serving.
const pluginsDir = process.env.INTERVIEW_OS_PLUGINS_DIR ?? DEFAULT_PLUGINS_DIR;
const pluginErrors = await loadPlugins(pluginsDir, orchestrator, logger);

const app = createApp({ orchestrator, runtime, runtimes: runtime, store, logger, pluginErrors });

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info("server.listening", {
    port: info.port,
    runtime: runtime.kind,
    db: path.basename(dbPath),
  });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.shutdown", { signal });
  server.close(() => {});
  try {
    await runtime.dispose();
  } catch (err) {
    logger.warn("server.runtime_dispose_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    store.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
