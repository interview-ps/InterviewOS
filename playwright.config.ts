import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_PORT = 4310;
const DB = path.join(os.tmpdir(), "interview-os-e2e.db");

export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: "live-codex.spec.ts",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${SERVER_PORT}`,
    screenshot: "only-on-failure",
  },
  webServer: {
    // build the SPA, then serve UI + API from one server (like `pnpm start`)
    command: "node tests/e2e/serve.mjs",
    url: `http://127.0.0.1:${SERVER_PORT}/api/runtime/status`,
    env: {
      INTERVIEW_OS_RUNTIME: "mock",
      INTERVIEW_OS_DB: DB,
      INTERVIEW_OS_PORT: String(SERVER_PORT),
      INTERVIEW_OS_TEST_MODE: "1",
      // small per-chunk delay so streamed deltas are observable in the UI
      INTERVIEW_OS_MOCK_DELAY_MS: "80",
      // v0.4 Level 2: load the hostile frame fixture as an "installed" plugin
      INTERVIEW_OS_INSTALLED_PLUGINS_DIR: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "tests/fixtures/installed-plugins",
      ),
    },
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
