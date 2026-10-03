import { expect, test } from "@playwright/test";
import { drainSession, freshWorkspace } from "./helpers";

// §9.4 full loops + §9.7 history/progress — fresh workspace per test.
test.describe("interview loops", () => {
  test.beforeEach(async ({ request }) => {
    await freshWorkspace(request);
  });

  test("2-round loop: handoff, per-round deltas, debrief, weak filter, progress", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    // build a 2-round custom loop (coding → behavioral); the prefilled
    // company loop is [technical, coding, system_design, behavioral, hr]
    await page.goto("/interview");
    await page.getByTestId("open-loop-builder").click();
    const builder = page.getByTestId("loop-builder");
    await builder.getByLabel("Remove round 1").click();
    await builder.getByLabel("Remove round 4").click();
    await builder.getByLabel("Remove round 2").click();
    await expect(builder.getByLabel("Round 1 mode")).toHaveValue("coding");
    await expect(builder.getByLabel("Round 2 mode")).toHaveValue("behavioral");
    await builder.getByLabel("Round 1 questions").fill("1");
    await builder.getByLabel("Round 2 questions").fill("1");
    await page.getByTestId("start-loop").click();
    await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 30_000 });
    // session header: mode · profile · loop round (text spans several nodes —
    // textContent concatenates without whitespace between them)
    await expect(page.locator("h1")).toContainText(
      /Coding\s*·\s*Generic profile\s*·\s*Loop round 1 \/ 2/,
    );
    await page.screenshot({ path: "test-results/loop-1-r1.png", fullPage: true });

    // round 1: coding — answer, follow-ups, finish → "Continue to round 2"
    await drainSession(page, "I would loop over the items and collect them.");
    await page.screenshot({ path: "test-results/loop-2-r1-done.png", fullPage: true });
    await page.getByTestId("next-round").click();
    await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 30_000 });
    await expect(page.getByText(/Loop round 2 \/ 2/)).toBeVisible();

    // round 2: behavioral — a STAR-ish answer, then finish → loop debrief
    await drainSession(
      page,
      "When I was at Acme our team had an outage and I led the fix, which reduced MTTR by 40% and we shipped it.",
    );
    await page.getByTestId("loop-link").click();
    await expect(page).toHaveURL(/\/interview\/loop\//);
    await expect(page.getByTestId("loop-debrief")).toBeVisible({ timeout: 30_000 });
    // taxonomy labels, not raw ids, in the handoff panel
    await expect(page.getByTestId("handoff-0")).toBeVisible();
    await expect(page.getByTestId("handoff-0")).not.toContainText(/\w+\.\w+-/);
    // per-round skill readiness deltas on the debrief
    await expect(page.getByTestId("debrief-deltas")).toBeVisible();
    await page.screenshot({ path: "test-results/loop-3-debrief.png", fullPage: true });

    // §9.7 History: weak-only filter surfaces the weak coding round
    await page.goto("/history");
    await page.getByTestId("weak-only").check();
    await expect(page.getByText("weak answer").first()).toBeVisible();
    await page.screenshot({ path: "test-results/loop-4-history-weak.png", fullPage: true });

    // §9.7 Home progress card
    await page.goto("/");
    await expect(page.getByTestId("progress-card")).toBeVisible();
    await expect(page.getByTestId("progress-card").getByText("Loops completed")).toBeVisible();
    await page.screenshot({ path: "test-results/loop-5-progress.png", fullPage: true });
  });
});
