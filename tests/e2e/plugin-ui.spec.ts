import { expect, test } from "@playwright/test";
import { API, freshWorkspace } from "./helpers";

// v0.4 plugin UI extensions: declarative slots, plugin navigation, plugin
// pages, interview modes, and enable/disable gating.

test.describe("plugin UI extensions (v0.4)", () => {
  test("dashboard card starts a plugin interview mode; plugin page renders tabs", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    await page.goto("/");

    // dashboard.cards slot: the PostgreSQL readiness card renders declaratively
    const card = page.getByText("PostgreSQL readiness").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText("from plugin PostgreSQL Interviewer").first(),
    ).toBeVisible();

    // the card's button starts the declared interview mode
    await page
      .getByRole("button", { name: "Start PostgreSQL Deep Dive" })
      .click();
    await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 60_000 });

    // plugin navigation appears under the shell's Plugins group
    await page.goto("/");
    const nav = page.getByRole("link", { name: "PostgreSQL" }).first();
    await expect(nav).toBeVisible({ timeout: 30_000 });
    await nav.click();
    await expect(page).toHaveURL(/\/plugins\/postgres-interviewer\/?/);

    // the declarative page renders its tabs
    await expect(page.getByText("Queries")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Indexes")).toBeVisible();
    await expect(page.getByText("Transactions")).toBeVisible();
    await expect(page.getByText("Locking")).toBeVisible();
  });

  test("disabling the plugin removes its card, nav, and page", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    await page.goto("/");
    await expect(page.getByText("PostgreSQL readiness").first()).toBeVisible({
      timeout: 30_000,
    });

    const res = await request.put(`${API}/api/plugins/postgres-interviewer`, {
      data: { enabled: false },
    });
    expect(res.ok()).toBe(true);

    await page.goto("/");
    await expect(page.getByText("Overall readiness")).toBeVisible();
    await expect(page.getByText("PostgreSQL readiness")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "PostgreSQL" }),
    ).toHaveCount(0);

    // the page route 404s while the plugin is disabled
    await page.goto("/plugins/postgres-interviewer/");
    await expect(page.getByText(/not found|404/i).first()).toBeVisible();

    // restore for other specs
    await request.put(`${API}/api/plugins/postgres-interviewer`, {
      data: { enabled: true },
    });
  });

  test("Level 2: postgres readiness panel renders in a sandboxed iframe and its button starts practice", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    await page.goto("/readiness");

    // the frame contribution is a sandboxed iframe, not host DOM
    const frame = page
      .locator('iframe[data-testid="plugin-frame"][sandbox="allow-scripts"]')
      .first();
    await expect(frame).toBeVisible({ timeout: 30_000 });

    const inner = frame.contentFrame();
    await expect(
      inner.getByText("PostgreSQL readiness").first(),
    ).toBeVisible({ timeout: 30_000 });
    for (const tab of ["Queries", "Indexes", "Transactions", "Locking"]) {
      await expect(inner.getByRole("tab", { name: tab })).toBeVisible();
    }

    // a frame SDK action reaches the host only through the closed vocabulary
    await inner.getByRole("button", { name: /^Practice/ }).first().click();
    await expect(page).toHaveURL(/\/interview\//, { timeout: 60_000 });
  });

  test("Level 2: hostile frame plugin cannot escape the sandbox", async ({
    page,
    request,
  }) => {
    await freshWorkspace(request);
    // the fixture loads via INTERVIEW_OS_INSTALLED_PLUGINS_DIR (git source → disabled)
    const res = await request.put(`${API}/api/plugins/frame-escape`, {
      data: { enabled: true },
    });
    expect(res.ok(), await res.text()).toBe(true);

    await page.goto("/");
    const frame = page
      .locator('iframe[title*="frame-escape"], iframe[title*="Escape"]')
      .first();
    await expect(frame).toBeVisible({ timeout: 30_000 });

    const inner = frame.contentFrame();
    const results = inner.locator('[data-testid="probe-results"]');
    await expect(results).toHaveAttribute("data-done", "1", {
      timeout: 30_000,
    });
    const text = (await results.textContent()) ?? "";

    const expected = {
      parentDocument: /^blocked:/,
      // top.location assignment is silently refused by Chromium — the real
      // assertion is that the parent never navigates (checked below)
      fetchApi: /^blocked:/,
      remoteImage: /^blocked:/,
      localStorage: /^blocked:/,
      cookie: /^blocked:/,
      remoteScript: /^blocked:/,
      windowOpen: /^blocked:/,
      xhrApi: /^blocked:/,
    };
    const lines = Object.fromEntries(
      text
        .split("\n")
        .map((l) => l.split(/: (.+)/).slice(0, 2) as [string, string]),
    );
    for (const [name, pattern] of Object.entries(expected)) {
      expect(lines[name], `${name} → ${lines[name]}`).toMatch(pattern);
    }

    // the parent page is untouched: no navigation, no DOM mutation, no popup
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-injected="escape"]')).toHaveCount(0);
    expect(page.url()).not.toContain("escape.example");
  });
});
