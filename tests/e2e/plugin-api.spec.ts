import { expect, test } from "@playwright/test";
import { API, freshWorkspace } from "./helpers";

// Plugin API v1: evaluation.review observations on the session page and
// preparation.suggest → "Add to plan" on the prepare page.

test.describe("plugin API v1 (e2e)", () => {
  test("plugin review observations appear after submitting a SQL answer", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);

    // grant everything the postgres plugin declared (incl. answers.read)
    const plugins = await (
      await request.get(`${API}/api/plugins`)
    ).json();
    const pg = plugins.plugins.find(
      (p: { manifest: { id: string } }) =>
        p.manifest.id === "postgres-interviewer",
    );
    const enable = await request.put(
      `${API}/api/plugins/postgres-interviewer`,
      {
        data: { enabled: true, grantedPermissions: pg.manifest.permissions },
      },
    );
    expect(enable.ok()).toBe(true);

    // start a session pinned to a sql.* skill so the plugin's
    // appliesTo.skillPrefixes: [sql] filter matches deterministically
    const start = await request.post(`${API}/api/interviews`, {
      data: {
        mode: "practice",
        focusSkillId: "sql.indexing",
        plannedQuestions: 1,
      },
    });
    expect(start.ok()).toBe(true);
    const { session } = await start.json();

    await page.goto(`/interview/${session.id}`);
    const box = page.locator("textarea").first();
    await expect(box).toBeVisible({ timeout: 30_000 });
    await box.fill(
      "I would add a composite index on (tenant_id, created_at) and verify it with EXPLAIN ANALYZE.",
    );
    await page.getByRole("button", { name: "Submit Answer" }).click();

    await expect(page.getByText("Plugin reviews")).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByText("from plugin PostgreSQL Interviewer").first(),
    ).toBeVisible();
  });

  test("plugin preparation suggestions can be added to the plan", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    await page.goto("/prepare");

    await expect(page.getByText("Suggestions from plugins")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText(/from plugin Interview Day Checklist/i).first(),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Add to plan" })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Added" }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});
