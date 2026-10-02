import { expect, test } from "@playwright/test";

const POOR_ANSWER =
  "I would put Redis in front of the database using cache-aside so reads are fast.";

// minimal one-page PDF with a text object (proper xref so pdf.js parses it)
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

test.describe("core loop", () => {
  test("setup → gaps → interview → weak evidence → readiness → reprioritized plan", async ({
    page,
  }) => {
    // Settings: mock runtime is reported; model/effort/mode settings save
    await page.goto("/settings");
    await expect(page.getByText("Mock Runtime").first()).toBeVisible();
    await expect(
      page.getByRole("option", { name: /Mock \(deterministic\)/i }),
    ).toBeAttached();
    await page.getByLabel(/Task mode/i).selectOption("exec");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
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
    // SSE streaming: the "evaluating answer" stage (and a streamed summary
    // draft) is visible before the final evaluation renders
    await expect(page.getByText(/evaluating answer/i)).toBeVisible();
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
    await page.screenshot({ path: "test-results/e2e-7-self-check.png", fullPage: true });

    // Readiness detail for that skill now shows a self_report evidence entry
    await page.goto("/readiness");
    await page
      .locator('[data-skill="distributed-systems.caching.cache-invalidation"]')
      .click();
    await expect(page.getByText("self_report").first()).toBeVisible();
    await expect(page.getByText(/Self-check: met/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/e2e-8-self-report.png", fullPage: true });

    // Documents: upload a generated PDF — the textarea is filled via extraction
    await page.goto("/target");
    await page
      .locator('input[aria-label="Upload resume file"]')
      .setInputFiles({
        name: "resume.pdf",
        mimeType: "application/pdf",
        buffer: minimalPdf("Jordan Reyes senior backend engineer"),
      });
    const resumeLabel = page.locator("label", {
      has: page.locator('input[aria-label="Upload resume file"]'),
    });
    await expect(resumeLabel.locator("textarea")).toHaveValue(
      /Jordan Reyes senior backend engineer/,
      { timeout: 30_000 },
    );
    await expect(page.getByText(/resume\.pdf — \d+ characters/i)).toBeVisible();
    await page.screenshot({ path: "test-results/e2e-9-pdf-upload.png", fullPage: true });

    // §8.4 Stories: generate from resume, then coach a story
    await page.goto("/stories");
    await page.getByRole("button", { name: "Generate from resume" }).click();
    await expect(
      page.getByText(/\[add metric\]/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "test-results/e2e-10-stories.png", fullPage: true });
    await page.getByRole("button", { name: "Coach me" }).first().click();
    await expect(
      page.locator('[data-testid^="coach-"]').getByText(/missing|needs work|shape/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "test-results/e2e-11-coach.png", fullPage: true });

    // §8.4 Behavioral round: question → answer → STAR checklist
    await page.goto("/interview");
    await page.locator("label", { hasText: "Behavioral" }).click();
    await page.getByRole("button", { name: "Start Interview" }).click();
    await expect(page).toHaveURL(/\/interview\/int_/);
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
    await page.screenshot({ path: "test-results/e2e-12-star.png", fullPage: true });
  });
});
