import { expect, test } from "@playwright/test";
import { freshWorkspace } from "./helpers";

/**
 * Theme-axis evidence: the same representative screens in light and dark at a
 * desktop size, plus one screen under a non-default brand palette. These prove
 * the two-axis theming (mode × palette) without touching product behaviour.
 */

const SHOTS = process.env.DESIGN_SHOTS ?? "test-results/design";

const SCREENS: { path: string; slug: string }[] = [
  { path: "/", slug: "home" },
  { path: "/prepare", slug: "prepare" },
  { path: "/settings", slug: "settings" },
  { path: "/readiness", slug: "readiness" },
  { path: "/target", slug: "target" },
];

test.describe("theme matrix evidence", () => {
  test.beforeEach(async ({ request }) => {
    await freshWorkspace(request);
  });

  for (const mode of ["light", "dark"] as const) {
    test(`desktop 1366x768 — ${mode}`, async ({ page }) => {
      await page.addInitScript((m: string) => {
        try {
          localStorage.setItem("interview-os:theme", m);
          localStorage.removeItem("interview-os:palette");
          localStorage.removeItem("interview-os:custom-color");
        } catch {
          /* ignore */
        }
      }, mode);
      await page.setViewportSize({ width: 1366, height: 768 });
      for (const screen of SCREENS) {
        await page.goto(screen.path, { waitUntil: "networkidle" });
        await page.waitForTimeout(200);
        await page.screenshot({
          path: `${SHOTS}/${mode}-${screen.slug}-1366x768.png`,
        });
      }
    });
  }

  test("desktop 1366x768 — rose palette", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("interview-os:theme", "light");
        localStorage.setItem("interview-os:palette", "rose");
      } catch {
        /* ignore */
      }
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/palette-rose-home-1366x768.png` });
    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.getByTestId("palette-swatches")).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/palette-rose-settings-1366x768.png` });
  });
});
