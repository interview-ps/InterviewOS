import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "../src/orchestrator/index.js";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "../src/skills/index.js";
import { createApp } from "../src/http/app.js";
import { REPO_ROOT } from "../src/paths.js";
import { loadPlugins } from "../src/startup/plugins.js";

const logger = createLogger({ level: "error", sink: () => {} });
const fixtureDir = path.join(REPO_ROOT, "tests/fixtures/plugins");
const pluginsDir = path.join(REPO_ROOT, "plugins");

const example = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "examples/backend-engineer/meta.json"), "utf8"),
) as {
  company: string;
  role: string;
  level: "junior" | "mid" | "senior" | "staff";
};
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

function makeOrchestrator() {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const orchestrator = new InterviewOrchestrator({
    store: openStore(":memory:"),
    runtime,
    logger,
  });
  return { orchestrator, runtime };
}

async function setup(orch: InterviewOrchestrator) {
  await orch.setupWorkspace({
    resumeText,
    jobDescription,
    company: example.company,
    role: example.role,
    level: example.level,
  });
}

describe("plugin loader (§9.6)", () => {
  it("rejects a plugin requesting write permissions", async () => {
    const { orchestrator } = makeOrchestrator();
    const errors = await loadPlugins(fixtureDir, orchestrator, logger);
    const rejected = errors.find((e) => e.dir === "write-access");
    expect(rejected?.error).toMatch(/write permission/);
    const manifests = orchestrator.listSkillManifests();
    expect(manifests.find((m) => m.id === "write-access")).toBeUndefined();
    expect(manifests.find((m) => m.id === "target-only")).toBeDefined();
  });

  it("plugin receives only declared slices and ctx.runtime is denied", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    await setup(orchestrator);
    const out = (await orchestrator.runPlugin("target-only")) as {
      keys: string[];
      hasCandidate: boolean;
      target: { company: string } | null;
      runtimeError: string | null;
    };
    // target-only declares only `target` — candidate must never be assembled
    expect(out.keys).toEqual(["target"]);
    expect(out.hasCandidate).toBe(false);
    expect(out.target?.company).toBe(example.company);
    expect(out.runtimeError).toBe("PERMISSION_DENIED");
  });

  it("sample interview-day-checklist loads and produces checklist items", async () => {
    const { orchestrator } = makeOrchestrator();
    const errors = await loadPlugins(pluginsDir, orchestrator, logger);
    expect(errors).toEqual([]);
    const manifest = orchestrator
      .listSkillManifests()
      .find((m) => m.id === "interview-day-checklist");
    expect(manifest?.kind).toBe("plugin");
    await setup(orchestrator);
    const out = (await orchestrator.runPlugin("interview-day-checklist")) as {
      title: string;
      items: { title: string }[];
    };
    expect(out.items.length).toBeGreaterThanOrEqual(4); // 3 weak areas + STAR + logistics
    expect(out.items.some((i) => i.title === "STAR reminder")).toBe(true);
  });

  it("GET /api/skills lists built-ins, plugins and load errors", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    const errors = await loadPlugins(fixtureDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime, pluginErrors: errors });
    const body = await json(await app.request("/api/skills"));
    const kinds = new Map(body.skills.map((s: { id: string; kind: string }) => [s.id, s.kind]));
    expect(kinds.get("resume-analyzer")).toBe("builtin");
    expect(kinds.get("interviewer")).toBe("builtin");
    expect(kinds.get("target-only")).toBe("plugin");
    expect(body.pluginErrors.some((e: { dir: string }) => e.dir === "write-access")).toBe(
      true,
    );
  });

  it("POST /api/plugins/:id/run executes the plugin", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime });
    const res = await app.request("/api/plugins/target-only/run", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.output.keys).toEqual(["target"]);
    expect(body.output.runtimeError).toBe("PERMISSION_DENIED");
    // unknown plugin → 404-level error
    const missing = await app.request("/api/plugins/nope/run", { method: "POST" });
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });
});
