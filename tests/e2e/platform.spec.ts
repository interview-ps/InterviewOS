import { expect, test } from "@playwright/test";
import { API, freshWorkspace } from "./helpers";

// v0.4 platform surface: plugins, packs, interview packs, question bank,
// settings data export/import, voice-toggle resilience.

test.describe("platform (v0.4)", () => {
  test("plugin permission review → enable → run renders questions", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    await page.goto("/skills");

    const card = page.locator('[data-testid="plugin-postgres-interviewer"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText("PostgreSQL Interviewer");

    // bundled plugins start enabled — disable, then re-enable via review
    await card.getByRole("button", { name: "Disable" }).click();
    await expect(
      card.locator('[data-testid="enable-postgres-interviewer"]'),
    ).toBeVisible();
    await card.locator('[data-testid="enable-postgres-interviewer"]').click();
    const review = card.locator(
      '[data-testid="perm-review-postgres-interviewer"]',
    );
    await expect(review).toBeVisible();

    // isolation-denied categories are greyed with the blocked note
    const permTable = review.locator('[data-testid="perm-table"]');
    await expect(permTable).toContainText("Network");
    await expect(permTable).toContainText("blocked by isolation");
    await expect(permTable).toContainText("DENIED");

    // evidence.write stays unchecked by default, with the warning
    const evidenceGrant = review.locator(
      '[data-testid="grant-evidence-write"]',
    );
    await expect(evidenceGrant).not.toBeChecked();
    await expect(
      review.getByText("lets this plugin add evidence to your readiness graph"),
    ).toBeVisible();

    // enable with defaults
    await review.locator('[data-testid="save-permissions"]').click();
    await expect(card.getByText("enabled").first()).toBeVisible();

    // run → questions renderer
    await card.locator('[data-testid="run-plugin-postgres-interviewer"]').click();
    await expect(card.locator('[data-testid="plugin-questions"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      card.locator('[data-testid="plugin-questions"]').getByText(/B-tree/),
    ).toBeVisible();
  });

  test("packs page lists the Stripe company pack with community provenance", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    await page.goto("/packs");

    const pack = page.locator('[data-testid="company-pack-stripe"]');
    await expect(pack).toBeVisible();
    await expect(pack).toContainText("community");
    // expand → community pills on items
    await pack.getByRole("button").first().click();
    await expect(
      pack.getByText("Community (unverified)").first(),
    ).toBeVisible();
  });

  test("create an interview pack, export link, start lands on the loop page", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    await page.goto("/packs");
    await page.getByTestId("tab-interviews").click();
    await page.getByTestId("toggle-create-pack").click();

    await page.getByTestId("pack-name").fill("E2E Loop Pack");
    // pick the first requirement skill chip (label wraps the checkbox)
    await page
      .locator('[data-testid="pack-creator"] fieldset label')
      .first()
      .click();
    await page.getByTestId("create-pack").click();

    const pack = page.locator("li", { hasText: "E2E Loop Pack" }).first();
    await expect(pack).toBeVisible();

    const exportLink = pack.locator('[data-testid^="export-pack-"]');
    await expect(exportLink).toHaveAttribute(
      "href",
      /\/api\/interview-packs\/[^/]+\/export$/,
    );

    await pack.locator('[data-testid^="start-pack-"]').click();
    await expect(page).toHaveURL(/\/interview\/loop\//, { timeout: 30_000 });
  });

  test("question bank question surfaces with a source badge in a session", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);

    // add a bank question for every target requirement via the API (robust:
    // whichever skill the first question targets, the bank has a candidate)
    const targets = await request.get(`${API}/api/targets`);
    const [t] = (await targets.json()) as { id: string }[];
    const state = await request.get(`${API}/api/state`);
    const s = (await state.json()) as {
      target: { requirements: { skillId: string }[] };
    };
    for (const r of s.target.requirements.slice(0, 12)) {
      const res = await request.post(`${API}/api/question-bank`, {
        data: {
          skillId: r.skillId,
          text: `E2E bank question for ${r.skillId}: describe a real trade-off you made here.`,
          difficulty: "medium",
        },
      });
      expect(res.ok()).toBeTruthy();
    }
    void t;

    await page.goto("/interview");
    await page.getByRole("button", { name: "Start Interview" }).first().click();
    await expect(page).toHaveURL(/\/interview\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByText("From your question bank")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("settings shows data export links; export → import with confirm shows counts", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    await page.goto("/settings");
    // Settings is category-based: open the Data category.
    await page.getByRole("menuitem", { name: "Data" }).click();

    await expect(page.getByTestId("export-all")).toBeVisible();
    for (const part of [
      "candidate",
      "targets",
      "readiness",
      "evidence",
      "interviews",
      "preparation",
    ]) {
      await expect(page.getByTestId(`export-${part}`)).toHaveAttribute(
        "href",
        `/api/export/${part}`,
      );
    }

    // pull the full bundle via the API, then import it through the UI
    const bundle = await (await request.get(`${API}/api/export`)).json();
    await page.getByTestId("import-file").setInputFiles({
      name: "export.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(bundle)),
    });
    await expect(page.getByTestId("import-preview")).toBeVisible();
    await page.getByTestId("import-confirm").fill("replace");
    await page.getByTestId("import-run").click();
    await expect(page.getByTestId("import-result")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("import-result")).toContainText(
      "candidate.profiles",
    );
  });

  test("session page voice toggle is hidden or harmless without Speech API", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    // enable voice in settings via the API
    await request.put(`${API}/api/settings`, {
      data: { voice: { enabled: true, speakQuestions: false } },
    });
    await page.goto("/interview");
    await page.getByRole("button", { name: "Start Interview" }).first().click();
    await expect(page).toHaveURL(/\/interview\/[^/]+$/, { timeout: 30_000 });
    // Chromium exposes webkitSpeechRecognition; either state must not break the page
    const toggle = page.getByTestId("voice-toggle");
    const note = page.getByTestId("voice-unsupported");
    await expect(toggle.or(note)).toBeVisible();
    await expect(page.getByPlaceholder(/answer|approach/i)).toBeVisible();
  });
});
