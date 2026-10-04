import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const DEFAULT_DB_PATH = path.join(REPO_ROOT, "data/interview-os.db");
export const DEFAULT_PLUGINS_DIR = path.join(REPO_ROOT, "plugins");
export const DEFAULT_INSTALLED_PLUGINS_DIR = path.join(REPO_ROOT, "data/plugins");
export const DEFAULT_EXAMPLES_DIR = path.join(REPO_ROOT, "examples");
export const DEFAULT_WEB_DIST = path.join(REPO_ROOT, "apps/web/dist");

/** v0.4 Level 2: built iframe runtime bundle served at /api/ui/runtime/. */
export const DEFAULT_UI_RUNTIME_DIR = path.join(REPO_ROOT, "packages/ui/dist/runtime");

/** v0.4 packs: bundled content ships with the repo; installed packs are user-added. */
export const DEFAULT_PACKS_DIR =
  process.env.INTERVIEW_OS_PACKS_DIR ?? path.join(REPO_ROOT, "packs");
export const DEFAULT_INSTALLED_PACKS_DIR =
  process.env.INTERVIEW_OS_INSTALLED_PACKS_DIR ?? path.join(REPO_ROOT, "data/packs");

/** v0.4 MCP: server commands are configured ONLY via this local file. */
export const DEFAULT_MCP_CONFIG_PATH =
  process.env.INTERVIEW_OS_MCP_CONFIG ??
  path.join(REPO_ROOT, "interview-os.mcp.json");

/** v1: trusted local runtime providers — local config only, never HTTP. */
export const DEFAULT_RUNTIMES_CONFIG_PATH =
  process.env.INTERVIEW_OS_RUNTIMES_CONFIG ??
  path.join(REPO_ROOT, "interview-os.runtimes.json");
