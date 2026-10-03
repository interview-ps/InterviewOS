import { expect, test, type Page } from "@playwright/test";
import { drainSession } from "./helpers";

const API = "http://127.0.0.1:4310";

/**
 * Live-Codex E2E (§8.3): real local Codex, no mock. Opt-in via
 * INTERVIEW_OS_LIVE_CODEX=1 (`pnpm test:e2e:live`). Assertions are deliberately
 * loose — the point is that the pipeline works end to end on a live model.
 */
test.skip(
  !process.env.INTERVIEW_OS_LIVE_CODEX,
  "live codex run — set INTERVIEW_OS_LIVE_CODEX=1",
);

test("live codex: setup → interview → evaluation → evidence", async ({
  page,
}) => {
  const t0 = Date.now();
  const mark = (step: string) =>
    console.log(`[live] ${step}: +${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Settings shows a connected Codex runtime
  await page.goto("/settings");
  await expect(page.getByText(/ready|connected/i).first()).toBeVisible({
    timeout: 30_000,
  });
  mark("settings/runtime ready");

  // Target Role: load backend example → analyze → gaps visible
  await page.goto("/target");
  await page.getByLabel(/Load example/i).selectOption("backend-engineer");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText(/analyzing|calculating|building/i).first())
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Identified gaps")).toBeVisible({
    timeout: 240_000,
  });
  mark("setup + gaps");

  // Interview: start → a streamed question appears
  await page.goto("/interview");
  await page.getByRole("button", { name: "Start Interview" }).click();
  await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 60_000 });
  const question = page.locator("p.leading-relaxed, .text-base.font-medium").first();
  await expect(question).not.toBeEmpty({ timeout: 180_000 });
  mark("first question");

  // Submit a short weak caching answer → evaluation renders
  await page.getByPlaceholder("Type your answer…").fill(
    "I'd add Redis in front of Postgres so reads hit the cache.",
  );
  await page.getByRole("button", { name: "Submit Answer" }).click();
  await expect(page.getByText(/evaluating answer/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("What was missing")).toBeVisible({
    timeout: 180_000,
  });
  mark("evaluation");

  // Readiness shows interview evidence for some skill
  await page.goto("/readiness");
  await expect(page.getByText(/%/i).first()).toBeVisible({ timeout: 30_000 });
  mark("readiness");
});

/**
 * §9.4 live loop: coding → system_design → behavioral, one question each, all
 * through the UI against real Codex. Generous timeouts — each model
 * round-trip can take a minute.
 */
test("live codex: 3-round loop through the UI", async ({ page, request }) => {
  // observed: a single system-design eval took ~4 min on live Codex; 40 min
  // total gives each of 6+ model round-trips ample headroom
  test.setTimeout(2_400_000);
  const t0 = Date.now();
  const mark = (step: string) =>
    console.log(`[live-loop] ${step}: +${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const sessionId = (p: Page) => p.url().split("/interview/")[1]!;

  // the first question's selection metadata, straight from the API
  const selectionReason = async (p: Page) => {
    const res = await request.get(`${API}/api/interviews/${sessionId(p)}`);
    const detail = await res.json();
    const q = detail.questions?.find((x: { followUpOf: unknown }) => !x.followUpOf);
    return {
      reason: q?.selectionReason ?? null,
      factors: q?.selectionFactors ?? null,
    };
  };

  /** Finish the round after the evaluation renders (drain any follow-ups). */
  async function finishRound(p: Page, answer: string) {
    // live follow-ups are another full model round-trip each — allow 10 min
    await drainSession(p, answer, 600_000);
  }

  // Target setup via the example
  await page.goto("/target");
  await page.getByLabel(/Load example/i).selectOption("backend-engineer");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("Identified gaps")).toBeVisible({
    timeout: 240_000,
  });
  mark("setup");

  // Loop builder: prefill [technical, coding, system_design, behavioral, hr]
  // → trim to [coding, system_design, behavioral], 1 question each
  await page.goto("/interview");
  await page.getByTestId("open-loop-builder").click();
  const builder = page.getByTestId("loop-builder");
  await builder.getByLabel("Remove round 1").click(); // technical
  await builder.getByLabel("Remove round 4").click(); // hr
  await expect(builder.getByLabel("Round 1 mode")).toHaveValue("coding");
  await expect(builder.getByLabel("Round 2 mode")).toHaveValue("system_design");
  await expect(builder.getByLabel("Round 3 mode")).toHaveValue("behavioral");
  for (const n of [1, 2, 3]) {
    await builder.getByLabel(`Round ${n} questions`).fill("1");
  }
  await page.getByTestId("start-loop").click();
  await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 120_000 });
  mark("loop started");

  // --- round 1: coding — streamed question, answer with code
  await expect(page.getByText(/Loop round 1 \/ 3/)).toBeVisible();
  await expect(page.getByTestId("coding-problem")).toBeVisible({
    timeout: 240_000,
  });
  mark("round1 question (coding)");
  await page
    .getByPlaceholder(/Explain your approach/i)
    .fill("Hash map from value to index; for each x look up target - x. O(n).");
  await page
    .getByLabel("Code answer")
    .fill(
      "function twoSum(nums, t) { const m = new Map(); for (let i = 0; i < nums.length; i++) { if (m.has(t - nums[i])) return [m.get(t - nums[i]), i]; m.set(nums[i], i); } }",
    );
  await page.getByRole("button", { name: "Submit Answer" }).click();
  await expect(page.getByTestId("rubric")).toBeVisible({ timeout: 420_000 });
  mark("round1 evaluation");
  await finishRound(page, "It iterates once and keeps a map; O(n) time, O(n) space.");
  await expect(page.getByTestId("next-round")).toBeVisible({ timeout: 60_000 });
  mark("round1 debrief + handoff");

  // --- round 2: system design — selection reason should reference round 1
  await page.getByTestId("next-round").click();
  await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 120_000 });
  await expect(page.getByText(/Loop round 2 \/ 3/)).toBeVisible();
  await expect(page.getByTestId("design-dimensions")).toBeVisible({
    timeout: 240_000,
  });
  const sel2 = await selectionReason(page);
  console.log(
    `[live-loop] round2 selection: ${JSON.stringify({ reason: sel2.reason, weaknessBoost: sel2.factors?.weaknessBoost })}`,
  );
  mark("round2 question (system_design)");
  await page
    .getByPlaceholder("Type your answer…")
    .fill(
      "Read-heavy cache with write-through; hashed keys, LRU eviction, TTL per entry, invalidation on write; measure hit rate before sharding.",
    );
  await page.getByRole("button", { name: "Submit Answer" }).click();
  await expect(page.getByTestId("rubric")).toBeVisible({ timeout: 420_000 });
  mark("round2 evaluation");
  await finishRound(page, "Capacity-wise: a few GB of hot keys fits one node; replicate for HA.");
  await expect(page.getByTestId("next-round")).toBeVisible({ timeout: 60_000 });
  mark("round2 debrief + handoff");

  // --- round 3: behavioral — reason may reference earlier rounds
  await page.getByTestId("next-round").click();
  await expect(page).toHaveURL(/\/interview\/int_/, { timeout: 120_000 });
  await expect(page.getByText(/Loop round 3 \/ 3/)).toBeVisible();
  await expect(page.getByPlaceholder("Type your answer…")).toBeVisible({
    timeout: 240_000,
  });
  const sel3 = await selectionReason(page);
  console.log(
    `[live-loop] round3 selection: ${JSON.stringify({ reason: sel3.reason, weaknessBoost: sel3.factors?.weaknessBoost })}`,
  );
  mark("round3 question (behavioral)");
  await page
    .getByPlaceholder("Type your answer…")
    .fill(
      "At Acme our payment service flaked in prod; I led the rollback, added reconciliation checks, and cut repeat incidents — zero recurrence in 6 months.",
    );
  await page.getByRole("button", { name: "Submit Answer" }).click();
  await expect(page.getByTestId("rubric")).toBeVisible({ timeout: 420_000 });
  mark("round3 evaluation");
  await finishRound(
    page,
    "We paired a postmortem with alerts on reconciliation lag; follow-ups closed in a week.",
  );
  mark("round3 debrief (loop complete)");

  // --- loop debrief renders with signals + per-round readiness deltas
  await page.getByTestId("loop-link").click();
  await expect(page).toHaveURL(/\/interview\/loop\//);
  await expect(page.getByTestId("loop-debrief")).toBeVisible({
    timeout: 420_000,
  });
  mark("loop debrief");

  // --- history shows the loop sessions
  await page.goto("/history");
  await expect(page.getByText(/loop round/).first()).toBeVisible({
    timeout: 30_000,
  });
  mark("history shows loop");
});
