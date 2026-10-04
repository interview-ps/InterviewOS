import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "../src/orchestrator/index.js";
import { MockRuntime } from "@interview-os/runtime";
import {
  SkillManifestSchema,
  createLogger,
  type Permission,
} from "@interview-os/core";
import { registerMockHandlers } from "../src/skills/index.js";
import { createApp } from "../src/http/app.js";
import { REPO_ROOT } from "../src/paths.js";
import { loadPlugins } from "../src/startup/plugins.js";

const logger = createLogger({ level: "error", sink: () => {} });
const fixtureDir = path.join(REPO_ROOT, "tests/fixtures/plugins");
const pluginsDir = path.join(REPO_ROOT, "plugins");

const example = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "examples/backend-engineer/meta.json"), "utf8"),
) as { company: string; role: string; level: "senior" };
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

const packsDir = path.join(REPO_ROOT, "packs");

function makeOrchestrator(withPacks = false) {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orchestrator = new InterviewOrchestrator({
    store,
    runtime,
    logger,
    ...(withPacks
      ? {
          packDirs: {
            bundled: packsDir,
            installed: fs.mkdtempSync(path.join(os.tmpdir(), "ios-ui-packs-")),
          },
        }
      : {}),
  });
  return { orchestrator, runtime, store };
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

const render = (app: ReturnType<typeof createApp>, id: string, body: unknown) =>
  app.request(`/api/plugins/${id}/ui/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** In-memory declarative UI plugin; counts executor invocations. */
function countingPlugin(id = "ui-counter") {
  const manifest = SkillManifestSchema.parse({
    id,
    version: "1.0.0",
    kind: "plugin",
    description: "counting UI fixture",
    inputs: [],
    permissions: [] as Permission[],
    capabilities: ["ui"],
    ui: {
      slots: {
        "dashboard.cards": [{ component: "counter-card", kind: "declarative" }],
      },
    },
  });
  let calls = 0;
  const executor = {
    execute: () => {
      calls += 1;
      return {
        ui: { type: "stat", label: "counter", value: `run ${calls}` },
      };
    },
  };
  return { manifest, executor, calls: () => calls };
}

describe("plugin UI contributions (v0.4)", () => {
  it("GET /api/ui/contributions lists enabled plugins only", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    const errors = await loadPlugins(pluginsDir, orchestrator, logger);
    expect(errors).toEqual([]);
    const app = createApp({ orchestrator, runtime });

    const body = await json(await app.request("/api/ui/contributions"));
    const pg = body.contributions.find(
      (c: { pluginId: string }) => c.pluginId === "postgres-interviewer",
    );
    expect(pg.pluginName).toBe("PostgreSQL Interviewer");
    expect(pg.navigation[0]).toMatchObject({ label: "PostgreSQL" });
    expect(pg.commands[0].id).toBe("start-pg");
    expect(pg.slots["dashboard.cards"][0]).toMatchObject({
      component: "readiness-card",
      kind: "declarative",
    });
    expect(pg.slots["readiness.panels"][0].kind).toBe("frame");
    expect(pg.pages[0]).toMatchObject({ path: "/", component: "home" });
    expect(pg.interviewModes[0].id).toBe("pg-deep-dive");

    await app.request("/api/plugins/postgres-interviewer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const after = await json(await app.request("/api/ui/contributions"));
    expect(
      after.contributions.find(
        (c: { pluginId: string }) => c.pluginId === "postgres-interviewer",
      ),
    ).toBeUndefined();
  });
});

describe("POST /api/plugins/:id/ui/render (v0.4)", () => {
  it("renders a declared declarative component", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    await setup(orchestrator);
    const app = createApp({ orchestrator, runtime });
    const res = await render(app, "postgres-interviewer", {
      slot: "dashboard.cards",
      component: "readiness-card",
    });
    expect(res.status).toBe(200);
    const { ui } = await json(res);
    expect(ui.type).toBe("card");
    expect(ui.title).toBe("PostgreSQL readiness");
  });

  it("rejects undeclared components and frame kinds", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime });
    expect(
      (
        await render(app, "postgres-interviewer", {
          slot: "dashboard.cards",
          component: "nope",
        })
      ).status,
    ).toBe(400);
    // declared but kind: frame — not renderable in Part A
    const frame = await render(app, "postgres-interviewer", {
      slot: "readiness.panels",
      component: "postgres-skill-tree",
    });
    expect(frame.status).toBe(400);
    expect((await json(frame)).error.message).toMatch(/frame/);
  });

  it("rejects disabled plugins with 409", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    await orchestrator.setPluginEnabled("postgres-interviewer", false);
    const app = createApp({ orchestrator, runtime });
    const res = await render(app, "postgres-interviewer", {
      slot: "dashboard.cards",
      component: "readiness-card",
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("PLUGIN_DISABLED");
  });

  it("returns 422 when the plugin emits an invalid tree", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    const manifest = SkillManifestSchema.parse({
      id: "bad-ui",
      version: "1.0.0",
      kind: "plugin",
      description: "invalid tree fixture",
      inputs: [],
      permissions: [] as Permission[],
      capabilities: ["ui"],
      ui: { slots: { "dashboard.cards": [{ component: "c", kind: "declarative" }] } },
    });
    orchestrator.registerPlugin(manifest, {
      execute: () => ({ ui: { type: "script", text: "alert(1)" } }),
    });
    const app = createApp({ orchestrator, runtime });
    const res = await render(app, "bad-ui", {
      slot: "dashboard.cards",
      component: "c",
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("PLUGIN_OUTPUT");
  });

  it("caches renders and invalidates on evidence writes + grant changes", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    const counter = countingPlugin();
    orchestrator.registerPlugin(counter.manifest, counter.executor);
    await setup(orchestrator);
    const app = createApp({ orchestrator, runtime });

    const req = { slot: "dashboard.cards", component: "counter-card" };
    const r1 = await json(await render(app, "ui-counter", req));
    const r2 = await json(await render(app, "ui-counter", req));
    expect(r1.ui.value).toBe("run 1");
    expect(r2.ui.value).toBe("run 1"); // cache hit — plugin not re-invoked
    expect(counter.calls()).toBe(1);

    // evidence write (postgres self-check with evidence.write granted) bumps the epoch
    const view = await orchestrator.setPluginEnabled("postgres-interviewer", true, [
      "candidate.read",
      "target.read",
      "readiness.read",
      "taxonomy.read",
      "evidence.write",
    ]);
    expect(view.grantedPermissions).toContain("evidence.write");
    const run = await orchestrator.runPlugin("postgres-interviewer", {
      selfCheck: [{ skillId: "sql.indexing", passed: true }],
    });
    expect(run.evidenceWritten).toBe(1);
    const r3 = await json(await render(app, "ui-counter", req));
    expect(r3.ui.value).toBe("run 2");
    expect(counter.calls()).toBe(2);
  });
});

describe("plugin interview modes (v0.4)", () => {
  it("starts a plugin mode, stores focus skills, and feeds packFocus", async () => {
    const { orchestrator, runtime } = makeOrchestrator(true);
    await loadPlugins(pluginsDir, orchestrator, logger);
    // probe plugin: its mode's focusSkills cover every target requirement, so
    // whichever skill the planner selects must carry a packFocus factor.
    await setup(orchestrator);
    const { target } = await orchestrator.getState();
    const focusSkills = target.requirements.map(
      (r: { skillId: string }) => r.skillId,
    );
    expect(focusSkills.length).toBeGreaterThan(0);
    const manifest = SkillManifestSchema.parse({
      id: "mode-probe",
      version: "1.0.0",
      kind: "plugin",
      description: "plugin-mode fixture",
      inputs: [],
      permissions: [] as Permission[],
      interviewModes: [
        {
          id: "probe",
          label: "Probe Mode",
          roundType: "technical",
          focusSkills,
          plannedQuestions: 3,
        },
      ],
    });
    orchestrator.registerPlugin(manifest, { execute: () => ({}) });
    const app = createApp({ orchestrator, runtime });

    const res = await app.request("/api/interviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginModeId: "mode-probe:probe" }),
    });
    expect(res.status).toBe(200);
    const { session } = await json(res);
    expect(session.roundType).toBe("technical");
    expect(session.plannedQuestions).toBe(3);
    expect(session.focusSkills).toEqual(focusSkills);

    // the first question's picked skill is a requirement → packFocus recorded
    const detail = await orchestrator.getInterview(session.id);
    const q = detail.questions[0];
    expect(q).toBeTruthy();
    expect(q?.selectionFactors?.packFocus).toBeGreaterThan(0);

    // the bundled manifest's own mode resolves too and stores its focus skills
    const pg = await app.request("/api/interviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginModeId: "postgres-interviewer:pg-deep-dive" }),
    });
    expect(pg.status).toBe(200);
    const { session: pgSession } = await json(pg);
    expect(pgSession.roundType).toBe("technical");
    expect(pgSession.plannedQuestions).toBe(4);
    expect(pgSession.focusSkills).toEqual([
      "sql.indexing",
      "sql.transactions",
      "sql.query-optimization",
    ]);
  });

  it("rejects unknown and disabled plugin modes", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    await setup(orchestrator);
    const app = createApp({ orchestrator, runtime });
    const bad = await app.request("/api/interviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginModeId: "postgres-interviewer:nope" }),
    });
    expect(bad.status).toBe(400);
    await orchestrator.setPluginEnabled("postgres-interviewer", false);
    const disabled = await app.request("/api/interviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginModeId: "postgres-interviewer:pg-deep-dive" }),
    });
    expect(disabled.status).toBe(409);
  });
});

describe("plugin UI manifest validation (v0.4)", () => {
  it("rejects a ui section without the ui capability at load", async () => {
    const { orchestrator } = makeOrchestrator();
    const errors = await loadPlugins(fixtureDir, orchestrator, logger);
    const err = errors.find((e) => e.dir === "ui-no-capability");
    expect(err?.error).toMatch(/without the "ui" capability/);
    expect(
      orchestrator.listSkillManifests().find((m) => m.id === "ui-no-capability"),
    ).toBeUndefined();
  });

  it("rejects frame entry path traversal at load", async () => {
    const { orchestrator } = makeOrchestrator();
    const errors = await loadPlugins(fixtureDir, orchestrator, logger);
    const err = errors.find((e) => e.dir === "frame-traversal");
    expect(err?.error).toMatch(/safe entry path under ui\//);
  });
});
