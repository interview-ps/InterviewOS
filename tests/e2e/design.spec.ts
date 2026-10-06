import { expect, test } from "@playwright/test";
import { freshWorkspace } from "./helpers";

/**
 * Design evidence: viewport screenshots (not just full-page) at the desktop
 * sizes the compact layout targets. These are the acceptance artefacts for the
 * desktop workspace — a very tall full-page image is not sufficient evidence.
 */

const SHOTS = process.env.DESIGN_SHOTS ?? "test-results/design";

const DESKTOP_VIEWPORTS = [
  { w: 1280, h: 720 },
  { w: 1366, h: 768 },
  { w: 1440, h: 900 },
];

const SCREENS: { path: string; slug: string }[] = [
  { path: "/", slug: "home" },
  { path: "/prepare", slug: "prepare" },
  { path: "/settings", slug: "settings" },
  { path: "/readiness", slug: "readiness" },
  { path: "/target", slug: "target" },
];

test.describe("design evidence", () => {
  test.beforeEach(async ({ request }) => {
    await freshWorkspace(request);
  });

  test("desktop viewports: key screens", async ({ page }) => {
    for (const vp of DESKTOP_VIEWPORTS) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      for (const screen of SCREENS) {
        await page.goto(screen.path, { waitUntil: "networkidle" });
        await page.waitForTimeout(150);
        await page.screenshot({
          path: `${SHOTS}/${screen.slug}-${vp.w}x${vp.h}.png`,
        });
      }
    }
  });

  test("target requirements tab (1366x768)", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/target", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Requirements" }).click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/target-requirements-1366x768.png` });
  });

  test("coding session + evaluation (1366x768)", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/interview", { waitUntil: "networkidle" });
    await page.locator("label", { hasText: "Coding" }).first().click();
    await page.getByRole("button", { name: "Start Interview" }).click();
    await expect(page.getByTestId("coding-problem")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/session-coding-1366x768.png` });
    await page.getByPlaceholder(/Explain your approach/i).fill("Iterate once with an ordered map.");
    await page.getByLabel("Code answer").fill("def solve(a):\n    return a");
    await page.getByRole("button", { name: "Submit Answer" }).click();
    await expect(page.getByText("What was missing")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/session-coding-eval-1366x768.png` });
  });

  test("resume coach overview + bullets (1366x768)", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/resume", { waitUntil: "networkidle" });
    await page.getByTestId("run-review").click();
    await expect(page.getByTestId("ats-score")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/resume-overview-1366x768.png` });
    await page.getByRole("button", { name: "Bullet suggestions" }).click();
    await expect(page.getByTestId("suggestions-card")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/resume-bullets-1366x768.png` });
  });

  test("command palette (1366x768)", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.keyboard.press("Control+K");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/palette-1366x768.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();
    await page.screenshot({ path: `${SHOTS}/palette-closed-1366x768.png` });
  });

  test("narrow mobile (390x844)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const screen of SCREENS) {
      await page.goto(screen.path, { waitUntil: "networkidle" });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/narrow-${screen.slug}-390x844.png` });
    }
  });

  test("narrow mobile (320x720)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    for (const screen of SCREENS) {
      await page.goto(screen.path, { waitUntil: "networkidle" });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/narrow-${screen.slug}-320x720.png` });
    }
  });

  test("tablet (834x1112)", async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1112 });
    for (const screen of SCREENS) {
      await page.goto(screen.path, { waitUntil: "networkidle" });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/tablet-${screen.slug}-834x1112.png` });
    }
  });

  test("mobile interactions (390x844)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // Preparation: the task queue opens in a drawer.
    await page.goto("/prepare", { waitUntil: "networkidle" });
    const queue = page.getByTestId("open-task-queue");
    if (await queue.isVisible().catch(() => false)) {
      await queue.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${SHOTS}/narrow-prepare-tasks-390x844.png` });
      await page.keyboard.press("Escape");
    }

    // Readiness: selecting a skill opens the detail drawer.
    await page.goto("/readiness", { waitUntil: "networkidle" });
    await page.getByTestId("skill-row").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${SHOTS}/narrow-readiness-detail-390x844.png` });
    await page.keyboard.press("Escape");

    // Settings: category selector opens the dropdown.
    await page.goto("/settings", { waitUntil: "networkidle" });
    await page.getByLabel("Settings category").click();
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${SHOTS}/narrow-settings-category-390x844.png` });
    await page.keyboard.press("Escape");

    // Resume: the bullet list opens in a drawer.
    await page.goto("/resume", { waitUntil: "networkidle" });
    await page.getByTestId("run-review").click();
    await expect(page.getByTestId("ats-score")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Bullet suggestions" }).click();
    await page.getByTestId("open-bullets").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${SHOTS}/narrow-resume-bullets-390x844.png` });
  });
});
