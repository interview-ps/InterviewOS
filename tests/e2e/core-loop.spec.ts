import { expect, test } from "@playwright/test";

const POOR_ANSWER =
  "I would put Redis in front of the database using cache-aside so reads are fast.";

test.describe("core loop", () => {
  test("setup → gaps → interview → weak evidence → readiness → reprioritized plan", async ({
    page,
  }) => {
    // Settings: mock runtime is reported
    await page.goto("/settings");
    await expect(page.getByText("Mock Runtime").first()).toBeVisible();
    await page.screenshot({ path: "test-results/e2e-1-settings.png", fullPage: true });

    // Target Role: load the canonical backend example and analyze
    await page.goto("/target");
    await page.getByLabel(/Load example/i).selectOption("backend-engineer");
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page.getByText("Identified gaps")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/caching/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/e2e-2-target-gaps.png", fullPage: true });

    // Prep Plan has actions
    await page.goto("/prep");
    await expect(page.locator("section").filter({ hasText: "#1" }).first()).toBeVisible();
    await expect(page.getByText(/cache/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/e2e-3-prep.png", fullPage: true });

    // Interview: start, answer the caching question poorly
    await page.goto("/interview");
    await page.getByRole("button", { name: "Start Interview" }).click();
    await expect(page).toHaveURL(/\/interview\/int_/);
    await expect(
      page.getByText(/consistent with the database/i),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByPlaceholder("Type your answer…").fill(POOR_ANSWER);
    await page.getByRole("button", { name: "Submit Answer" }).click();
    await expect(page.getByText("What was missing")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/invalidat|ttl|expir/i).first(),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/e2e-4-evaluation.png", fullPage: true });

    // Readiness: cache-invalidation shows the interview evidence
    await page.goto("/readiness");
    await page
      .locator('[data-skill="distributed-systems.caching.cache-invalidation"]')
      .click();
    await expect(page.getByText("Why the system believes this")).toBeVisible();
    await expect(page.getByText(/did not address|invalidat/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/e2e-5-readiness.png", fullPage: true });

    // Prep Plan: priority-1 action targets cache invalidation
    await page.goto("/prep");
    const top = page.locator("section").filter({ hasText: "#1" }).first();
    await expect(top).toBeVisible();
    await expect(top).toContainText(/invalidat/i);
    await page.screenshot({ path: "test-results/e2e-6-prep-priority.png", fullPage: true });
  });
});
