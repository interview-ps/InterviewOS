import { expect, test } from "@playwright/test";
import { freshWorkspace } from "./helpers";

// §9.1 interview modes — each test gets a fresh DB + canonical workspace.
test.describe("interview modes", () => {
  test.beforeEach(async ({ request }) => {
    await freshWorkspace(request);
  });

  async function startMode(page: import("@playwright/test").Page, label: string) {
    await page.goto("/interview");
    await page.locator("label", { hasText: label }).first().click();
    await page.getByRole("button", { name: "Start Interview" }).click();
    await expect(page).toHaveURL(/\/interview\/int_/);
  }

  test("coding: problem panel, code editor, rubric bars", async ({ page }) => {
    await startMode(page, "Coding");
    await expect(page.getByTestId("coding-problem")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "test-results/modes-1-coding.png", fullPage: true });
    await page
      .getByPlaceholder(/Explain your approach/i)
      .fill("I would loop over the array and check each pair.");
    await page
      .getByLabel("Code answer")
      .fill("function solve(a) { for (const x of a) return x; }");
    await page.getByRole("button", { name: "Submit Answer" }).click();
    await expect(page.getByTestId("rubric")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "test-results/modes-2-coding-eval.png", fullPage: true });
  });

  test("system design: dimension status panel beside the question", async ({ page }) => {
    await startMode(page, "System design");
    await expect(page.getByTestId("design-dimensions")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("design-dimensions").getByText("not covered").first(),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/modes-3-design.png", fullPage: true });
  });

  test("behavioral: STAR checklist in the evaluation", async ({ page }) => {
    // §8.4 stories first — generate from resume, then coach a story
    await page.goto("/prepare/stories");
    await page
      .getByRole("button", { name: "Generate from resume" })
      .first()
      .click();
    await expect(
      page.getByText(/\[add metric\]/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Coach me" }).first().click();
    await expect(
      page.locator('[data-testid^="coach-"]').getByText(/missing|needs work|shape/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    await startMode(page, "Behavioral");
    await expect(
      page.getByPlaceholder("Type your answer…"),
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByPlaceholder("Type your answer…")
      .fill("When I was at Acme our team had an outage and I led the fix.");
    await page.getByRole("button", { name: "Submit Answer" }).click();
    await expect(page.getByTestId("star-checklist")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId("star-checklist").getByText("Result", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/modes-4-star.png", fullPage: true });
  });

  test("hiring manager: question → answer → evaluation", async ({ page }) => {
    await startMode(page, "Hiring manager");
    await expect(
      page.getByPlaceholder("Type your answer…"),
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByPlaceholder("Type your answer…")
      .fill("I align the team on outcomes first, then unblock the riskiest dependency.");
    await page.getByRole("button", { name: "Submit Answer" }).click();
    await expect(page.getByTestId("rubric")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "test-results/modes-5-hm.png", fullPage: true });
  });
});
