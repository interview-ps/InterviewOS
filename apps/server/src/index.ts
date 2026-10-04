import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { openStore, InterviewOrchestrator } from "./orchestrator/index.js";
import {
  createRuntime,
  loadRuntimeProviders,
  MockRuntime,
} from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "./skills/index.js";
import { createApp } from "./http/app.js";
import { loadPlugins } from "./startup/plugins.js";
import {
  DEFAULT_DB_PATH,
  DEFAULT_INSTALLED_PACKS_DIR,
  DEFAULT_INSTALLED_PLUGINS_DIR,
  DEFAULT_MCP_CONFIG_PATH,
  DEFAULT_PACKS_DIR,
  DEFAULT_PLUGINS_DIR,
  DEFAULT_RUNTIMES_CONFIG_PATH,
  DEFAULT_WEB_DIST,
} from "./paths.js";
import { McpManager } from "./mcp/McpManager.js";

const logger = createLogger({ level: "info", service: "server" });

const dbPath = process.env.INTERVIEW_OS_DB ?? DEFAULT_DB_PATH;
const port = Number(process.env.INTERVIEW_OS_PORT ?? 4100);
const hostname = process.env.INTERVIEW_OS_HOST ?? "127.0.0.1";

const store = openStore(dbPath);
// v1: trusted local runtime providers load BEFORE createRuntime so a
// configured kind can be selected via env or the saved runtimeKind setting.
const { loaded: runtimeProviders, errors: runtimeProviderErrors } =
  await loadRuntimeProviders(DEFAULT_RUNTIMES_CONFIG_PATH, logger);
if (runtimeProviders.length > 0) {
  logger.info("runtime.providers_loaded", { kinds: runtimeProviders });
}
for (const error of runtimeProviderErrors) {
  logger.warn("runtime.provider_load_failed", { error });
}
// Saved UI selection wins only when INTERVIEW_OS_RUNTIME is unset.
const runtime = await createRuntime({
  env: process.env,
  logger,
  preferredKind: await store.getSetting("runtimeKind"),
  onSwitch: (rt) => {
    if (rt instanceof MockRuntime) registerMockHandlers(rt);
  },
});

const pluginsDir = process.env.INTERVIEW_OS_PLUGINS_DIR ?? DEFAULT_PLUGINS_DIR;
const installedPluginsDir =
  process.env.INTERVIEW_OS_INSTALLED_PLUGINS_DIR ??
  DEFAULT_INSTALLED_PLUGINS_DIR;

// v0.4 MCP: server commands come only from interview-os.mcp.json (env
// INTERVIEW_OS_MCP_CONFIG) — never from HTTP.
const mcp = new McpManager(DEFAULT_MCP_CONFIG_PATH, logger, async (id) => {
  const row = await store.getMcpServer(id);
  return {
    enabled: (row?.enabled ?? 0) === 1,
    allowedTools: (row?.allowedTools as string[] | undefined) ?? [],
  };
});

const orchestrator = new InterviewOrchestrator({
  store,
  runtime,
  logger,
  pluginDirs: { bundled: pluginsDir, installed: installedPluginsDir },
  packDirs: { bundled: DEFAULT_PACKS_DIR, installed: DEFAULT_INSTALLED_PACKS_DIR },
  mcp,
});

// §9.6: discover bundled + installed plugins before serving.
const pluginErrors = [
  ...(await loadPlugins(pluginsDir, orchestrator, logger, "bundled")),
  ...(await loadPlugins(installedPluginsDir, orchestrator, logger, "git")),
];
orchestrator.setPluginLoadErrors(pluginErrors);
// v1: register plugin-shipped packs for enabled plugins before pack lookups.
await orchestrator.syncPluginPacks();

// v0.4: load bundled + installed packs (errors surface via /api/packs).
await orchestrator.listPacks();

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
    // drain queued plugin events (bounded — a stuck plugin must not hang exit)
    await Promise.race([
      orchestrator.flushPluginEvents(),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
  } catch {
    /* best-effort */
  }
  try {
    await mcp.closeAll();
  } catch {
    /* best-effort */
  }
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
