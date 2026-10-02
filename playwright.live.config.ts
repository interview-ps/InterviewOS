import { defineConfig } from "@playwright/test";

const SERVER_PORT = 4100;
const WEB_PORT = 3000;
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
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `sh -c 'rm -f ${DB} && exec ../../node_modules/.bin/tsx src/index.ts'`,
      cwd: "apps/server",
      url: `http://127.0.0.1:${SERVER_PORT}/api/runtime/status`,
      env: {
        INTERVIEW_OS_RUNTIME: "codex",
        INTERVIEW_OS_DB: DB,
        INTERVIEW_OS_PORT: String(SERVER_PORT),
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "sh -c './node_modules/.bin/next build && exec ./node_modules/.bin/next start -p 3000'",
      cwd: "apps/web",
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
