import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "@interview-os/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { registerMockHandlers } from "@interview-os/skills";
import { createApp, REPO_ROOT } from "../src/app.js";

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

const post = (app: ReturnType<typeof makeServer>, path: string, body?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ?? "{}",
  });

describe("server api", () => {
  it("runtime status exposes health fields + mode", async () => {
    const app = makeServer();
    const res = await app.request("/api/runtime/status");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.mode).toBe("mock");
    expect(body.runtime).toBe("mock");
    expect(body.available).toBe(true);
    expect(body.status).toBe("ready");
  });

  it("serves examples", async () => {
    const app = makeServer();
    const list = await json(await app.request("/api/examples"));
    expect(list).toEqual(["backend-engineer", "data-engineer", "product-manager"]);
    const one = await json(await app.request("/api/examples/backend-engineer"));
    expect(one.company).toBe("Northwind Cloud");
    expect(one.resumeText).toContain("Python");
    const missing = await app.request("/api/examples/..secrets");
    expect(missing.status).toBe(404);
  });

  it("setup → state → interview → answer → readiness detail", async () => {
    const app = makeServer();

    const setup = await post(app, "/api/workspace/setup", setupBody);
    expect(setup.status).toBe(200);
    const setupOut = await json(setup);
    expect(setupOut.candidate.name).toBe("Jordan Reyes");

    const state = await json(await app.request("/api/state"));
    expect(state.readiness.dimensions["python"].score).toBeGreaterThanOrEqual(0.75);
    expect(state.preparation.priorities.length).toBeGreaterThan(0);

    const interview = await json(
      await post(app, "/api/interviews", JSON.stringify({ plannedQuestions: 2 })),
    );
    expect(interview.question.skillId).toBe("distributed-systems.caching");

    const answer = await post(
      app,
      `/api/interviews/${interview.session.id}/answer`,
      JSON.stringify({
        answer:
          "I would put Redis in front of the database using cache-aside so reads are fast.",
      }),
    );
    expect(answer.status).toBe(200);
    const answerOut = await json(answer);
    expect(answerOut.evaluation.weaknesses.length).toBeGreaterThan(0);
    expect(answerOut.newActions.length).toBeGreaterThan(0);

    const detail = await json(
      await app.request("/api/readiness/distributed-systems.caching.cache-invalidation"),
    );
    expect(detail.readiness.status).toBe("weak");
    expect(detail.readiness.evidenceIds.length).toBeGreaterThan(0);
    expect(detail.history.length).toBeGreaterThan(0);
    expect(
      detail.actions.some(
        (a: { status: string }) => a.status === "open" || a.status === "in_progress",
      ),
    ).toBe(true);
  }, 30_000);

  it("returns 409 on invalid transition", async () => {
    const app = makeServer();
    await post(app, "/api/workspace/setup", setupBody);
    const interview = await json(await post(app, "/api/interviews"));
    // session is in "question" — advancing again is invalid
    const res = await app.request(`/api/interviews/${interview.session.id}/next`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe("INVALID_TRANSITION");
  }, 30_000);

  it("validates bodies and enforces the size limit", async () => {
    const app = makeServer();
    const bad = await post(app, "/api/workspace/setup", JSON.stringify({ resumeText: "x" }));
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe("VALIDATION");

    const hugeBody = JSON.stringify({
      resumeText: "x".repeat(400 * 1024),
      jobDescription: "jd",
      company: "c",
      role: "r",
      level: "senior",
    });
    const huge = await app.request("/api/workspace/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(hugeBody)),
      },
      body: hugeBody,
    });
    expect(huge.status).toBe(413);
  });
});
