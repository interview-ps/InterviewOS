import { expect, test } from "@playwright/test";
import { API, freshWorkspace, minimalPdf, resetState } from "./helpers";

const POOR_ANSWER =
  "I would put Redis in front of the database using cache-aside so reads are fast.";

// v0.1/v0.2 canonical loop + practice + PDF — UI-driven setup on a fresh DB.
test.describe("core loop", () => {
  test.beforeEach(async ({ request }) => {
    await resetState(request);
  });

  test("setup → gaps → interview → weak evidence → readiness → reprioritized plan", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    // Settings: mock runtime is reported; model/effort/mode settings save
    await page.goto("/settings");
    await expect(page.getByText("Mock Runtime").first()).toBeVisible();
    await expect(
      page.getByRole("option", { name: /Mock \(deterministic\)/i }),
    ).toBeAttached();
    await page.getByLabel(/Reasoning effort/i).selectOption("high");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.screenshot({ path: "test-results/core-1-settings.png", fullPage: true });

    // Target Role: load the canonical backend example and analyze
    await page.goto("/target");
    await page.getByLabel(/Load example/i).selectOption("backend-engineer");
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page.getByText("Identified gaps")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/caching/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/core-2-target-gaps.png", fullPage: true });

    // Prep Plan has actions
    await page.goto("/prepare");
    await expect(page.locator("section").filter({ hasText: "#1" }).first()).toBeVisible();
    await expect(page.getByText(/cache/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/core-3-prep.png", fullPage: true });

    // Interview: start, answer the caching question poorly
    await page.goto("/interview");
    await page.getByRole("button", { name: "Start Interview" }).click();
    await expect(page).toHaveURL(/\/interview\/int_/);
    await expect(
      page.getByText(/consistent with the database/i),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByPlaceholder("Type your answer…").fill(POOR_ANSWER);
    await page.getByRole("button", { name: "Submit Answer" }).click();
    // SSE streaming: the "evaluating answer" stage (and a streamed summary
    // draft) is visible before the final evaluation renders
    await expect(page.getByText(/evaluating answer/i)).toBeVisible();
    await expect(page.getByText("What was missing")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/invalidat|ttl|expir/i).first(),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/core-4-evaluation.png", fullPage: true });

    // Readiness: cache-invalidation shows the interview evidence
    await page.goto("/readiness");
    await page
      .locator('[data-skill="distributed-systems.caching.cache-invalidation"]')
      .click();
    await expect(page.getByText("Evidence behind this score")).toBeVisible();
    await expect(page.getByText(/did not address|invalidat/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/core-5-readiness.png", fullPage: true });

    // Prep Plan: priority-1 action targets cache invalidation
    await page.goto("/prepare");
    const top = page.locator("section").filter({ hasText: "#1" }).first();
    await expect(top).toBeVisible();
    await expect(top).toContainText(/invalidat/i);
    await page.screenshot({ path: "test-results/core-6-prep-priority.png", fullPage: true });

    // Self-check: tick a success criterion on the priority-1 action and mark done
    await top.locator('input[type="checkbox"]').first().check();
    await top.getByRole("button", { name: /Mark done/ }).click();
    // the action moves into the collapsed History list once marked done
    const historyToggle = page.getByRole("button", { name: /History \(\d+\)/ });
    await expect(historyToggle).toBeVisible({ timeout: 30_000 });
    await historyToggle.click();
    await expect(
      page.locator("section").getByText(/invalidat/i).last(),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/core-7-self-check.png", fullPage: true });

    // Readiness detail for that skill now shows a self_report evidence entry
    await page.goto("/readiness");
    await page
      .locator('[data-skill="distributed-systems.caching.cache-invalidation"]')
      .click();
    await expect(page.getByText("Self report").first()).toBeVisible();
    await expect(page.getByText(/Self-check: met/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/core-8-self-report.png", fullPage: true });

    // Documents: upload a generated PDF — the textarea is filled via extraction
    await page.goto("/target");
    const resumeLabel = page.locator("label", {
      has: page.locator('input[aria-label="Upload resume file"]'),
    });
    const [resumeChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      resumeLabel.getByRole("button", { name: "Upload file" }).click(),
    ]);
    await resumeChooser.setFiles({
      name: "resume.pdf",
      mimeType: "application/pdf",
      buffer: minimalPdf("Jordan Reyes senior backend engineer"),
    });
    await expect(resumeLabel.locator("textarea")).toHaveValue(
      /Jordan Reyes senior backend engineer/,
      { timeout: 30_000 },
    );
    await expect(page.getByText(/resume\.pdf — \d+ characters/i)).toBeVisible();
    await page.screenshot({ path: "test-results/core-9-pdf-upload.png", fullPage: true });

    // §9.7: old routes redirect into the new navigation
    await page.goto("/prep");
    await expect(page).toHaveURL(/\/prepare$/);
    await page.goto("/stories");
    await expect(page).toHaveURL(/\/prepare\/stories$/);
  });

  // Draft autosave: an in-progress answer survives a page reload.
  test("in-progress answer is restored after a reload", async ({ page, request }) => {
    await freshWorkspace(request);
    const start = await request.post(`${API}/api/interviews`, {
      data: { mode: "practice", focusSkillId: "sql.indexing", plannedQuestions: 1 },
    });
    expect(start.ok()).toBe(true);
    const { session } = await start.json();

    await page.goto(`/interview/${session.id}`);
    const box = page.locator("textarea").first();
    await expect(box).toBeVisible({ timeout: 30_000 });
    await box.fill("A half-written answer that must survive a reload.");
    // let the 500 ms-debounced autosave flush to localStorage
    await page.waitForTimeout(800);

    // the beforeunload guard would otherwise block the reload; accept it
    page.on("dialog", (dialog) => void dialog.accept());
    await page.reload();

    await expect(page.locator("textarea").first()).toHaveValue(
      "A half-written answer that must survive a reload.",
      { timeout: 30_000 },
    );
  });
});
