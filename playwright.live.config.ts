import { defineConfig } from "@playwright/test";

const SERVER_PORT = 4310;
const DB = "/tmp/interview-os-e2e-live.db";

/**
 * Live-Codex E2E (§8.3). Run with: INTERVIEW_OS_LIVE_CODEX=1 pnpm test:e2e:live
 * Uses the real local Codex (app-server task mode by default) — no mock.
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "live-codex.spec.ts",
  timeout: 600_000,
  retries: 0,
  workers: 1,
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${SERVER_PORT}`,
    screenshot: "only-on-failure",
  },
  webServer: {
    // build the SPA, then serve UI + API from one server (like `pnpm start`)
    command:
      `sh -c 'rm -f ${DB} ${DB}-wal ${DB}-shm ${DB}-journal && corepack pnpm --filter @interview-os/web build && exec node_modules/.bin/tsx apps/server/src/index.ts'`,
    url: `http://127.0.0.1:${SERVER_PORT}/api/runtime/status`,
    env: {
      INTERVIEW_OS_RUNTIME: "codex",
      INTERVIEW_OS_DB: DB,
      INTERVIEW_OS_PORT: String(SERVER_PORT),
      // live Codex turns on a loaded machine can exceed the 120s default
      INTERVIEW_OS_CODEX_TIMEOUT_MS: "300000",
    },
    // surface server logs in the test output — live failures need them
    stderr: "pipe",
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
