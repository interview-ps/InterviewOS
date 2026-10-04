import { defineConfig } from "@playwright/test";

const SERVER_PORT = 4310;
const DB = "/tmp/interview-os-e2e.db";

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
    command:
      `sh -c 'rm -f ${DB} ${DB}-wal ${DB}-shm ${DB}-journal && corepack pnpm --filter @interview-os/web build && exec node_modules/.bin/tsx apps/server/src/index.ts'`,
    url: `http://127.0.0.1:${SERVER_PORT}/api/runtime/status`,
    env: {
      INTERVIEW_OS_RUNTIME: "mock",
      INTERVIEW_OS_DB: DB,
      INTERVIEW_OS_PORT: String(SERVER_PORT),
      INTERVIEW_OS_TEST_MODE: "1",
      // small per-chunk delay so streamed deltas are observable in the UI
      INTERVIEW_OS_MOCK_DELAY_MS: "80",
    },
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
