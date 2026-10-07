import { expect, test } from "@playwright/test";
import { API, freshWorkspace } from "./helpers";

// AI usage telemetry — the mock runtime reports deterministic usage so the page
// renders real rows under INTERVIEW_OS_RUNTIME=mock.
test.describe("AI usage", () => {
  test("shows mock-runtime usage after a workspace setup", async ({ page, request }) => {
    await freshWorkspace(request);

    await page.goto("/usage");
    await expect(page.getByRole("heading", { name: "AI Usage" })).toBeVisible({
      timeout: 30_000,
    });
    // reachable from the workspace nav (next to Settings), labelled "AI usage"
    await expect(page.getByRole("link", { name: "AI usage" }).first()).toBeVisible();
    await expect(page.getByText("Total tokens")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Cost (USD)")).toBeVisible();
    await expect(page.getByText("By runtime")).toBeVisible();
    await expect(page.getByText("By skill / task")).toBeVisible();
    await expect(page.getByText("By model")).toBeVisible();
    await expect(page.getByText("Recent turns")).toBeVisible();
    await page.screenshot({ path: "test-results/usage.png", fullPage: true });
  });

  test("shows an empty state when nothing has run", async ({ page, request }) => {
    await request.post(`${API}/api/test/reset`);
    await page.goto("/usage");
    await expect(page.getByText("No AI usage recorded yet")).toBeVisible({
      timeout: 30_000,
    });
  });
});
