import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "@interview-os/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { registerMockHandlers } from "@interview-os/skills";
import { createApp } from "../src/http/app.js";
import { REPO_ROOT } from "../src/paths.js";

const example = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "examples/backend-engineer/meta.json"), "utf8"),
) as { company: string; role: string; level: string };
const resumeText = fs.readFileSync(
  path.join(REPO_ROOT, "examples/backend-engineer/resume.md"),
  "utf8",
);
const jobDescription = fs.readFileSync(
  path.join(REPO_ROOT, "examples/backend-engineer/job.md"),
  "utf8",
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

function makeServer() {
  const logger = createLogger({ level: "error", sink: () => {} });
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orchestrator = new InterviewOrchestrator({ store, runtime, logger });
  return createApp({ orchestrator, runtime });
}

const setupBody = JSON.stringify({
  resumeText,
  jobDescription,
  company: example.company,
  role: example.role,
  level: example.level,
});

describe("resume review api (§9.5)", () => {
  it("POST /api/resume/review → ATS + guarded suggestions; GET latest persists", async () => {
    const app = makeServer();
    await app.request("/api/workspace/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: setupBody,
    });

    const res = await app.request("/api/resume/review", { method: "POST" });
    expect(res.status).toBe(200);
    const review = await json(res);
    expect(typeof review.ats.score).toBe("number");
    expect(review.ats.checks.length).toBeGreaterThan(0);
    expect(review.suggestions.length).toBeGreaterThan(0);
    // mock coach emits a "[add metric]" placeholder that must survive the guard
    expect(
      review.suggestions.some((s: { improved: string }) =>
        s.improved.includes("[add metric]"),
      ),
    ).toBe(true);
    expect(review.tailoring.summary.length).toBeGreaterThan(0);

    const latest = await json(
      await app.request("/api/resume/reviews/latest"),
    );
    expect(latest.id).toBe(review.id);
    expect(latest.ats.score).toBe(review.ats.score);
  });
});
