import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { openStore, InterviewOrchestrator } from "./orchestrator/index.js";
import { createRuntime, MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "./skills/index.js";
import { createApp } from "./http/app.js";
import { loadPlugins } from "./startup/plugins.js";
import { DEFAULT_DB_PATH, DEFAULT_PLUGINS_DIR, DEFAULT_WEB_DIST } from "./paths.js";

const logger = createLogger({ level: "info", service: "server" });

const dbPath = process.env.INTERVIEW_OS_DB ?? DEFAULT_DB_PATH;
const port = Number(process.env.INTERVIEW_OS_PORT ?? 4100);
const hostname = process.env.INTERVIEW_OS_HOST ?? "127.0.0.1";

const store = openStore(dbPath);
// Saved UI selection wins only when INTERVIEW_OS_RUNTIME is unset.
const runtime = await createRuntime({
  env: process.env,
  logger,
  preferredKind: await store.getSetting("runtimeKind"),
  onSwitch: (rt) => {
    if (rt instanceof MockRuntime) registerMockHandlers(rt);
  },
});

const orchestrator = new InterviewOrchestrator({ store, runtime, logger });

// §9.6: discover local plugins (default <repo>/plugins) before serving.
const pluginsDir = process.env.INTERVIEW_OS_PLUGINS_DIR ?? DEFAULT_PLUGINS_DIR;
const pluginErrors = await loadPlugins(pluginsDir, orchestrator, logger);

const webDir = fs.existsSync(path.join(DEFAULT_WEB_DIST, "index.html"))
  ? DEFAULT_WEB_DIST
  : undefined;

const app = createApp({
  orchestrator,
  runtime,
  runtimes: runtime,
  store,
  logger,
  pluginErrors,
  webDir,
});
logger.info("web.static", { enabled: webDir !== undefined });

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK.has(hostname)) {
  logger.warn("server.exposed", {
    host: hostname,
    message: "the API has no authentication and is reachable from the network",
  });
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  logger.info("server.listening", {
    host: hostname,
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
