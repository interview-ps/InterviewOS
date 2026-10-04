import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "@interview-os/server/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "@interview-os/server/skills";
import { createApp } from "../../apps/server/src/http/app.js";
import { loadPlugins } from "../../apps/server/src/startup/plugins.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SDK_BIN = path.join(REPO_ROOT, "packages/plugin-sdk/bin/interview-os.mjs");
const logger = createLogger({ level: "error", sink: () => {} });

const ex = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "examples/backend-engineer/meta.json"), "utf8"),
);
const setupInput = {
  resumeText: fs.readFileSync(path.join(REPO_ROOT, "examples/backend-engineer/resume.md"), "utf8"),
  jobDescription: fs.readFileSync(path.join(REPO_ROOT, "examples/backend-engineer/job.md"), "utf8"),
  company: ex.company as string,
  role: ex.role as string,
  level: "senior" as const,
};

const ID = "third-party-probe";

const SKILL_YAML = `id: ${ID}
name: Third-Party Probe
version: 1.0.0
description: Contract probe — exercises every Plugin API v1 extension point.
author: test
permissions:
  - taxonomy.read
  - answers.read
  - evidence.write
capabilities:
  - question_source
  - resources
  - evaluation
  - preparation
  - ui
  - interview
  - role_pack
hooks:
  - questions.suggest
  - resources.suggest
  - evaluation.review
  - preparation.suggest
  - ui.render
  - events.sessionCompleted
inputs:
  - request
events:
  - sessionCompleted
settings:
  - key: bias
    label: Bias tag
    type: string
    default: neutral
engines:
  interview-os: ">=0.4.0"
interviewModes:
  - id: probe-mode
    label: Probe Mode
    roundType: technical
    focusSkills: [probe.skill]
    plannedQuestions: 1
taxonomy:
  - id: probe.skill
    label: Probe Skill
    keywords: [probe]
ui:
  slots:
    dashboard.cards:
      - { component: probe-card, kind: declarative, title: "Probe card" }
`;

const VENDOR = `export const RESOURCE_TITLE = "probe-resource";
`;

const ENTRY = `import { defineSkill } from "@interview-os/plugin-sdk";
import { RESOURCE_TITLE } from "./vendor.mjs";

export default defineSkill({
  id: "${ID}",
  permissions: ["taxonomy.read", "answers.read", "evidence.write"],
  capabilities: ["question_source", "resources", "evaluation", "preparation", "ui", "interview", "role_pack"],
  handlers: {
    "questions.suggest"(req) {
      return {
        questions: [{
          skillId: "probe.skill",
          text: "Probe question about " + (req.skillId ?? "skill") + " today?",
          difficulty: "medium",
        }],
      };
    },
    async "resources.suggest"(req, ctx) {
      const n = (await ctx.storage.get("calls")) + 1 || 1;
      await ctx.storage.set("calls", n);
      return {
        resources: [{
          skillId: "probe.skill",
          title: RESOURCE_TITLE + " call " + n + " (" + ctx.settings.bias + ")",
          kind: "article",
          summary: "from " + (req.skillIds ?? []).join(","),
        }],
      };
    },
    "evaluation.review"(req) {
      return {
        observations: [{
          text: "probe saw answer: " + (req.answer ? "yes" : "no (answers.read not granted)"),
          tone: "blue",
        }],
        evidenceProposals: [{
          skillId: "probe.skill",
          score: 0.5,
          confidence: 0.3,
          observation: "probe review evidence",
        }],
      };
    },
    "preparation.suggest"() {
      return {
        activities: [{
          skillId: "probe.skill",
          title: "Probe activity",
          action: "Do the probe thing for ten minutes.",
          successCriteria: ["It is done"],
        }],
      };
    },
    "ui.render"(req) {
      return { ui: { type: "card", title: "probe card " + req.component, children: [] } };
    },
    async "events.sessionCompleted"(req, ctx) {
      await ctx.storage.set("fired", req.sessionId);
      return {
        evidenceProposals: [{
          skillId: "probe.skill",
          score: 0.6,
          confidence: 0.3,
          observation: "session completed event",
        }],
      };
    },
  },
});
`;

const ROLE_YAML = `format: interview-os.role-pack
id: probe-role
name: Probe Role
version: 1.0.0
description: Role pack shipped inside a plugin.
taxonomy: []
dimensions:
  - skillId: probe.skill
    weight: 0.9
defaultQuestionCategories:
  - technical
  - behavioral
rubrics: []
resources: []
`;

function makePluginDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-plugins-"));
  const pd = path.join(dir, ID);
  fs.mkdirSync(path.join(pd, "packs", "roles", "probe-role"), { recursive: true });
  fs.writeFileSync(path.join(pd, "skill.yaml"), SKILL_YAML);
  fs.writeFileSync(path.join(pd, "vendor.mjs"), VENDOR);
  fs.writeFileSync(path.join(pd, "index.js"), ENTRY);
  fs.writeFileSync(path.join(pd, "packs", "roles", "probe-role", "role.yaml"), ROLE_YAML);

  // contract-violating plugin: declared hook returns the wrong shape
  const bad = path.join(dir, "bad-shape");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(
    path.join(bad, "skill.yaml"),
    `id: bad-shape
version: 1.0.0
capabilities: [question_source]
hooks: [questions.suggest]
`,
  );
  fs.writeFileSync(
    path.join(bad, "index.js"),
    `export default { handlers: { "questions.suggest": () => ({ nope: 1 }) } };\n`,
  );

  // capability declared but no hook backs it → rejected at load
  const noback = path.join(dir, "no-backing");
  fs.mkdirSync(noback, { recursive: true });
  fs.writeFileSync(
    path.join(noback, "skill.yaml"),
    `id: no-backing
version: 1.0.0
capabilities: [resources]
hooks: [questions.suggest]
`,
  );
  fs.writeFileSync(
    path.join(noback, "index.js"),
    `export default { handlers: { "questions.suggest": () => ({ questions: [] }) } };\n`,
  );

  // `interview-os build` bundles index.js + vendor.mjs → dist/index.js
  execFileSync(process.execPath, [SDK_BIN, "build", pd], { stdio: "pipe" });
  return dir;
}

describe("third-party plugin (Plugin API v1)", () => {
  it("exercises every extension point end-to-end", { timeout: 120_000 }, async () => {
    const dir = makePluginDir();
    const runtime = new MockRuntime();
    registerMockHandlers(runtime);
    const store = openStore(":memory:");
    const orch = new InterviewOrchestrator({ store, runtime, logger });
    const errors = await loadPlugins(dir, orch, logger, "bundled");

    // bad-shape loads (contract violations fail at call time, not load);
    // no-backing is rejected at load for capability without a backing hook.
    expect(errors.some((e) => e.dir === "no-backing")).toBe(true);
    expect(errors.some((e) => e.dir === "bad-shape")).toBe(false);
    expect(errors.some((e) => e.dir === ID)).toBe(false);

    // grant everything the plugin declared (incl. answers.read + evidence.write)
    const manifest = orch.listSkillManifests().find((m) => m.id === ID)!;
    expect(manifest).toBeDefined();
    await orch.setPluginEnabled(ID, true, [...manifest.permissions]);
    await orch.syncPluginPacks();

    // 1. questions.suggest through the typed hook
    const q = await orch.invokePluginHook(ID, "questions.suggest", {
      skillId: "probe.skill",
      roundType: "technical",
      count: 1,
    });
    expect((q.output as { questions: unknown[] }).questions).toHaveLength(1);

    // 2. contract violation → PLUGIN_OUTPUT (fail-soft upstream)
    await expect(
      orch.invokePluginHook("bad-shape", "questions.suggest", {
        skillId: "probe.skill",
        roundType: "technical",
      }),
    ).rejects.toThrow(/invalid response|PLUGIN_OUTPUT/i);

    // 3. settings roundtrip over HTTP + visible inside the hook
    const app = createApp({ orchestrator: orch, runtime });
    const sres = await app.request(`/api/plugins/${ID}/settings`);
    const sbody = await sres.json();
    expect(sbody.fields[0].key).toBe("bias");
    expect(sbody.values.bias).toBe("neutral");
    await app.request(`/api/plugins/${ID}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { bias: "sharp" } }),
    });
    // unknown key rejected
    const badPut = await app.request(`/api/plugins/${ID}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { unknownKey: 1 } }),
    });
    expect(badPut.status).toBeGreaterThanOrEqual(400);

    // 4. KV storage persists across isolated runs (call counter)
    await orch.invokePluginHook(ID, "resources.suggest", { skillIds: ["probe.skill"] });
    const r2 = await orch.invokePluginHook(ID, "resources.suggest", {
      skillIds: ["probe.skill"],
    });
    const title = (r2.output as { resources: { title: string }[] }).resources[0]!.title;
    expect(title).toContain("call 2");
    expect(title).toContain("sharp"); // stored setting reached the hook
    expect(await store.getPluginStorageValue(ID, "calls")).toBe(2);

    // 5. shipped role pack loads with plugin provenance
    const packs = await orch.listPacks();
    const probeRole = packs.roles.find(
      (p: { id: string; source: string }) => p.id === "probe-role",
    );
    expect(probeRole?.source).toBe(`plugin:${ID}`);

    // 6. ui.render contribution renders through the hook contract
    const uiRes = await app.request(`/api/plugins/${ID}/ui/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "dashboard.cards", component: "probe-card" }),
    });
    expect(uiRes.status).toBe(200);
    expect((await uiRes.json()).ui.type).toBe("card");

    // 7. preparation.suggest → accept → prep action with plugin source
    // (needs an active candidate/target to attach the prep action to)
    await orch.setupWorkspace(setupInput);
    const sugg = await app.request("/api/preparation/suggestions");
    const sgBody = await sugg.json();
    const group = sgBody.suggestions.find((g: { pluginId: string }) => g.pluginId === ID);
    expect(group?.activities?.[0]?.title).toBe("Probe activity");
    const acc = await app.request("/api/preparation/suggestions/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId: ID, activity: group.activities[0] }),
    });
    expect(acc.status).toBe(200);
    const accBody = await acc.json();
    expect((await store.getAction(accBody.id))?.source).toBe(`plugin:${ID}`);

    // 8. evaluation.review fires inside a real interview on MockRuntime
    const start = await orch.startInterview({
      pluginModeId: `${ID}:probe-mode`,
      plannedQuestions: 1,
    });
    const submit = await orch.submitAnswer(
      start.session.id,
      "Probe answers use indexes and MVCC deliberately.",
    );
    const review = submit.pluginReviews?.find((r) => r.pluginId === ID);
    expect(review).toBeDefined();
    expect(review!.observations[0]!.text).toContain("yes"); // answers.read granted
    // its evidence proposal went through the gate (grant held → written)
    const pluginEvidence = (await store.listEvidence()).filter(
      (e) => e.source === `plugin:${ID}`,
    );
    expect(pluginEvidence.length).toBeGreaterThanOrEqual(1);

    // 9. sessionCompleted fires outside the lock (queued, fire-and-forget);
    // flush drains the queue, then storage marker + evidence are visible
    await orch.completeInterview(start.session.id);
    await orch.flushPluginEvents();
    expect(await store.getPluginStorageValue(ID, "fired")).toBe(start.session.id);
    const eventEvidence = (await store.listEvidence()).filter(
      (e) => e.source === `plugin:${ID}` && e.observation.includes("session completed"),
    );
    expect(eventEvidence.length).toBe(1);
  });
});
