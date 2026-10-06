import { test } from "@playwright/test";
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
});
