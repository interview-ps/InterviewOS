import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "../src/orchestrator/index.js";
import { MockRuntime, RuntimeManager } from "@interview-os/runtime";
import type { AIRuntime, RuntimeKind } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "../src/skills/index.js";
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

/** A MockRuntime posing as another provider kind (kind + healthCheck swapped). */
function fakeRuntime(kind: RuntimeKind, available = true): AIRuntime {
  const rt = new MockRuntime() as AIRuntime & { kind: RuntimeKind };
  rt.kind = kind;
  rt.healthCheck = async () => ({
    runtime: kind,
    available,
    status: available ? "ready" : "unavailable",
    version: "9.9-test",
  });
  return rt;
}

async function makeManagedServer() {
  const logger = createLogger({ level: "error", sink: () => {} });
  const store = openStore(":memory:");
  const manager = await RuntimeManager.create({
    env: { INTERVIEW_OS_RUNTIME: "mock" },
    logger,
    factory: (kind) => fakeRuntime(kind),
    healthCheckers: {
      codex: async () => ({
        runtime: "codex",
        available: false,
        status: "unavailable",
        message: "codex not found",
      }),
      claude: async () => ({ runtime: "claude", available: true, status: "ready" }),
      opencode: async () => ({ runtime: "opencode", available: true, status: "ready" }),
      devin: async () => ({ runtime: "devin", available: true, status: "ready" }),
    },
  });
  const orchestrator = new InterviewOrchestrator({ store, runtime: manager, logger });
  const app = createApp({ orchestrator, runtime: manager, runtimes: manager, store });
  return { app, store, manager };
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

  it("lists built-in company profiles at /api/companies", async () => {
    const app = makeServer();
    const res = await app.request("/api/companies");
    expect(res.status).toBe(200);
    const profiles = await json(res);
    expect(profiles.length).toBeGreaterThan(1);
    const generic = profiles.find((p: { id: string }) => p.id === "generic");
    expect(generic.name).toBeTruthy();
    expect(generic.disclaimer).toBeTruthy();
    expect(generic.typicalLoop.length).toBeGreaterThan(0);
    expect(generic.typicalLoop[0].mode).toBeTruthy();
    expect(generic.typicalLoop[0].label).toBeTruthy();
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

  it("streams answer evaluation over SSE (stage → delta → result)", async () => {
    const app = makeServer();
    await post(app, "/api/workspace/setup", setupBody);
    const interview = await json(await post(app, "/api/interviews"));

    const res = await app.request(
      `/api/interviews/${interview.session.id}/answer?stream=1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ answer: "cache-aside with Redis; no TTL plan." }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    const events = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events).toContain("stage");
    expect(events).toContain("delta");
    expect(events[events.length - 1]).toBe("result");
    expect(events.indexOf("stage")).toBeLessThan(events.indexOf("result"));
    expect(body).toContain('"evaluating answer"');
    const resultLine = body
      .split("\n")
      .find((l) => l.startsWith("data: ") && l.includes('"evaluation"'));
    expect(resultLine).toBeTruthy();
  }, 30_000);

  it("emits an error event (not an HTTP error) when a streamed op fails", async () => {
    const app = makeServer();
    const res = await app.request("/api/interviews/nope/answer?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "anything" }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).toContain('"NOT_FOUND"');
    expect(body).not.toContain("event: result");
  });

  it("settings + runtime models round-trip", async () => {
    const app = makeServer();
    const models = await json(await app.request("/api/runtime/models"));
    expect(models[0].id).toBe("mock");

    const before = await json(await app.request("/api/settings"));
    expect(before.taskMode).toBe("app-server");
    expect(before.model).toBeNull();

    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskMode: "exec", model: "mock" }),
    });
    expect(put.status).toBe(200);
    const after = await json(put);
    // taskMode is a Codex-only execution detail; the mock runtime ignores it.
    expect(after.taskMode).toBe("app-server");
    expect(after.model).toBe("mock");

    // a vanished model falls back to the provider default instead of erroring
    const fallback = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "no-such-model" }),
    });
    expect(fallback.status).toBe(200);
    expect((await json(fallback)).model).toBe("mock");
  });

  it("records usage events and serves metrics at /api", async () => {
    const app = makeServer();
    const ev = await post(app, "/api/events", JSON.stringify({ event: "palette.used" }));
    expect(ev.status).toBe(200);
    const bad = await post(app, "/api/events", JSON.stringify({ event: "nope" }));
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe("VALIDATION");

    const res = await app.request("/api/metrics");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.usage["palette.used"]).toBe(1);
    expect(body.loopsStarted).toBe(0);
  });

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

describe("runtime detection + switching", () => {
  it("lists detected providers with the active kind", async () => {
    const { app } = await makeManagedServer();
    const res = await app.request("/api/runtime/available");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.active).toBe("mock");
    expect(body.providers).toHaveLength(5);
    const codex = body.providers.find((p: { runtime: string }) => p.runtime === "codex");
    expect(codex.available).toBe(false);
    const mock = body.providers.find((p: { runtime: string }) => p.runtime === "mock");
    expect(mock.available).toBe(true);
  });

  it("returns an empty provider list without a manager", async () => {
    const app = makeServer();
    const body = await json(await app.request("/api/runtime/available"));
    expect(body.active).toBe("mock");
    expect(body.providers).toEqual([]);
  });

  it("switches the active runtime and persists the selection", async () => {
    const { app, store, manager } = await makeManagedServer();
    const res = await app.request("/api/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "claude" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.mode).toBe("claude");
    expect(manager.kind).toBe("claude");
    expect(await store.getSetting("runtimeKind")).toBe("claude");

    const status = await json(await app.request("/api/runtime/status"));
    expect(status.mode).toBe("claude");
  });

  it("rejects an unknown runtime kind", async () => {
    const { app } = await makeManagedServer();
    const res = await app.request("/api/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "gemini" }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION");
  });

  it("rejects switching when no manager is wired", async () => {
    const app = makeServer();
    const res = await app.request("/api/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "codex" }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION");
  });
});
