import { expect, test } from "@playwright/test";
import { freshWorkspace } from "./helpers";

// §9.5 resume coach, §9.6 skills & plugins, §9.7 command palette.
test.describe("resume coach, skills & plugins, command palette", () => {
  test.beforeEach(async ({ request }) => {
    await freshWorkspace(request);
  });

  test("resume review: ATS score + guarded [add metric] suggestions", async ({
    page,
  }) => {
    await page.goto("/resume");
    await expect(page.getByTestId("resume-banner")).toBeVisible();
    await page.getByTestId("run-review").click();
    await expect(page.getByTestId("ats-score")).toBeVisible({ timeout: 30_000 });
    // Bullet suggestions live on their own tab.
    await page.getByRole("button", { name: "Bullet suggestions" }).click();
    await expect(
      page.getByTestId("suggestions-card").getByText("[add metric]").first(),
    ).toBeVisible({ timeout: 30_000 });
    const card = page.getByTestId("suggestions-card");
    // bullets only come from experience/projects — never education lines
    await expect(card).not.toContainText("Ridgeview");
    // mock rewrites keep proper-noun casing (LedgerSync, not ledgerSync)
    await expect(card.getByText(/LedgerSync/).first()).toBeVisible();
    // "Role — Company — action" prefixes are folded in, not verbatim-prefixed
    await expect(
      card.getByText("Designed Python REST APIs for payment processing at Acme Payments"),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/rsp-1-resume.png", fullPage: true });
  });

  test("skills page lists the sample plugin and runs it", async ({ page }) => {
    await page.goto("/skills");
    await expect(
      page.getByText("interview-day-checklist").first(),
    ).toBeVisible();
    await page.getByTestId("run-plugin-interview-day-checklist").click();
    await expect(page.getByTestId("plugin-checklist")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByTestId("plugin-checklist").getByText("STAR reminder"),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/rsp-2-skills.png", fullPage: true });
    // Built-in skill manifests live on the Advanced tab.
    await page.getByRole("button", { name: "Advanced" }).click();
    await expect(page.getByTestId("skills-table")).toBeVisible();
    await page.screenshot({ path: "test-results/rsp-2b-skills-advanced.png", fullPage: true });
  });

  test("command palette: Ctrl+K → 'system' → system design session", async ({
    page,
  }) => {
    // networkidle: the Ctrl+K listener binds on hydration — don't press early
    await page.goto("/", { waitUntil: "networkidle" });
    await page.keyboard.press("Control+K");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.screenshot({ path: "test-results/rsp-3-palette.png", fullPage: true });
    await page.keyboard.type("system");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 30_000 });
    await expect(page.getByTestId("design-dimensions")).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: "test-results/rsp-4-palette-session.png", fullPage: true });
  });
});
