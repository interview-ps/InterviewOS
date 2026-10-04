import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "@interview-os/server/orchestrator";
import {
  createRuntime,
  loadRuntimeProviders,
  MockRuntime,
  type AIRuntime,
} from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "@interview-os/server/skills";
import { createApp } from "../../apps/server/src/http/app.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(REPO_ROOT, "tests/fixtures/runtime-provider/provider.mjs");
const logger = createLogger({ level: "error", sink: () => {} });

const ex = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "examples/backend-engineer/meta.json"), "utf8"),
);
const setupInput = {
  resumeText: fs.readFileSync(
    path.join(REPO_ROOT, "examples/backend-engineer/resume.md"),
    "utf8",
  ),
  jobDescription: fs.readFileSync(
    path.join(REPO_ROOT, "examples/backend-engineer/job.md"),
    "utf8",
  ),
  company: ex.company as string,
  role: ex.role as string,
  level: ex.level as string,
};

function writeConfig(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-runtimes-"));
  const p = path.join(dir, "interview-os.runtimes.json");
  fs.writeFileSync(p, JSON.stringify({ providers: entries }));
  return p;
}

const registerMocks = (rt: AIRuntime) => {
  if (rt instanceof MockRuntime) registerMockHandlers(rt);
};

describe("trusted local runtime providers (§5)", () => {
  it("loads a provider, switches to it, and runs the feedback flow; a bad module fails soft", async () => {
    const config = writeConfig([
      { kind: "fixture-runtime", module: FIXTURE },
      { kind: "broken-runtime", module: "./does-not-exist.mjs" },
      { kind: "codex", module: FIXTURE }, // collides with a built-in → error
    ]);
    const { loaded, errors } = await loadRuntimeProviders(config, logger);
    expect(loaded).toEqual(["fixture-runtime"]);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.includes("broken-runtime"))).toBe(true);

    const store = openStore(":memory:");
    const manager = await createRuntime({
      env: { INTERVIEW_OS_RUNTIME: "mock" },
      logger,
      onSwitch: registerMocks,
    });
    const orch = new InterviewOrchestrator({ store, runtime: manager, logger });
    const app = createApp({ orchestrator: orch, runtime: manager, runtimes: manager });

    // appears in GET /api/runtime/available tagged as a trusted local provider
    const avail = await app.request("/api/runtime/available");
    const providers = (await avail.json()).providers as {
      runtime: string;
      available: boolean;
      trustedLocal?: boolean;
    }[];
    const fixture = providers.find((p) => p.runtime === "fixture-runtime");
    expect(fixture?.available).toBe(true);
    expect(fixture?.trustedLocal).toBe(true);
    expect(providers.find((p) => p.runtime === "mock")?.trustedLocal).toBeUndefined();

    // PUT /api/runtime switches to it
    const sw = await app.request("/api/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "fixture-runtime" }),
    });
    expect(sw.status).toBe(200);
    expect((await sw.json()).mode).toBe("fixture-runtime");
    expect(manager.kind).toBe("fixture-runtime");

    // the full feedback flow runs on it (fixture wraps MockRuntime)
    await orch.setupWorkspace(setupInput);
    const start = await orch.startInterview({ plannedQuestions: 1 });
    const submit = await orch.submitAnswer(
      start.session.id,
      "I used an index to cut the lookup cost.",
    );
    expect(submit.evaluation).toBeDefined();
    await orch.completeInterview(start.session.id);

    // unknown kinds are still rejected
    const bad = await app.request("/api/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "not-a-runtime" }),
    });
    expect(bad.status).toBe(400);
  });
});
