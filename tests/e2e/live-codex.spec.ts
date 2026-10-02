import { expect, test } from "@playwright/test";

/**
 * Live-Codex E2E (§8.3): real local Codex, no mock. Opt-in via
 * INTERVIEW_OS_LIVE_CODEX=1 (`pnpm test:e2e:live`). Assertions are deliberately
 * loose — the point is that the pipeline works end to end on a live model.
 */
test.skip(
  !process.env.INTERVIEW_OS_LIVE_CODEX,
  "live codex run — set INTERVIEW_OS_LIVE_CODEX=1",
);

test("live codex: setup → interview → evaluation → evidence", async ({
  page,
}) => {
  const t0 = Date.now();
  const mark = (step: string) =>
    console.log(`[live] ${step}: +${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Settings shows a connected Codex runtime
  await page.goto("/settings");
  await expect(page.getByText(/ready|connected/i).first()).toBeVisible({
    timeout: 30_000,
  });
  mark("settings/runtime ready");

  // Target Role: load backend example → analyze → gaps visible
  await page.goto("/target");
  await page.getByLabel(/Load example/i).selectOption("backend-engineer");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText(/analyzing|calculating|building/i).first())
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Identified gaps")).toBeVisible({
    timeout: 240_000,
  });
  mark("setup + gaps");

  // Interview: start → a streamed question appears
  await page.goto("/interview");
  await page.getByRole("button", { name: "Start Interview" }).click();
  await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 60_000 });
  const question = page.locator("p.leading-relaxed, .text-base.font-medium").first();
  await expect(question).not.toBeEmpty({ timeout: 180_000 });
  mark("first question");

  // Submit a short weak caching answer → evaluation renders
  await page.getByPlaceholder("Type your answer…").fill(
    "I'd add Redis in front of Postgres so reads hit the cache.",
  );
  await page.getByRole("button", { name: "Submit Answer" }).click();
  await expect(page.getByText(/evaluating answer/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("What was missing")).toBeVisible({
    timeout: 180_000,
  });
  mark("evaluation");

  // Readiness shows interview evidence for some skill
  await page.goto("/readiness");
  await expect(page.getByText(/%/i).first()).toBeVisible({ timeout: 30_000 });
  mark("readiness");
});
