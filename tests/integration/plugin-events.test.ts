import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "@interview-os/server/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "@interview-os/server/skills";
import { loadPlugins } from "../../apps/server/src/startup/plugins.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const logger = createLogger({ level: "error", sink: () => {} });
const ID = "event-probe";
const SLOW_MS = 1_200;

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

const SKILL_YAML = `id: ${ID}
name: Event Probe
version: 1.0.0
description: Plugin API v1 lifecycle-event probe.
permissions:
  - evidence.write
events:
  - sessionCompleted
  - readinessUpdated
hooks:
  - events.sessionCompleted
  - events.readinessUpdated
engines:
  interview-os: ">=0.4.0"
`;

const ENTRY = `import { defineSkill } from "@interview-os/plugin-sdk";

export default defineSkill({
  id: "${ID}",
  permissions: ["evidence.write"],
  handlers: {
    async "events.sessionCompleted"(req, ctx) {
      await ctx.storage.set("sessionScores", req.scores);
      // deliberately slow — the user-facing call must not wait for this
      await new Promise((r) => setTimeout(r, ${SLOW_MS}));
      await ctx.storage.set("sessionDone", req.sessionId);
      return {};
    },
    async "events.readinessUpdated"(req, ctx) {
      const n = ((await ctx.storage.get("readyCalls")) ?? 0) + 1;
      await ctx.storage.set("readyCalls", n);
      await ctx.storage.set("changedIds", req.changedSkillIds);
      // propose evidence on every call: if plugin-caused recomputes were not
      // guarded, this would loop events back into the plugin forever.
      return {
        evidenceProposals: [{
          skillId: "distributed-systems.caching",
          score: 0.5,
          confidence: 0.3,
          observation: "event evidence from probe",
        }],
      };
    },
  },
});
`;

function makePluginDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-events-"));
  const pd = path.join(dir, ID);
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, "skill.yaml"), SKILL_YAML);
  fs.writeFileSync(path.join(pd, "index.js"), ENTRY);
  return dir;
}

describe("plugin lifecycle events (Plugin API v1)", () => {
  it(
    "events are fire-and-forget, fire from locked flows, and never loop",
    { timeout: 60_000 },
    async () => {
      const dir = makePluginDir();
      const runtime = new MockRuntime();
      registerMockHandlers(runtime);
      const store = openStore(":memory:");
      const orch = new InterviewOrchestrator({ store, runtime, logger });
      const errors = await loadPlugins(dir, orch, logger, "bundled");
      expect(errors).toEqual([]);
      await orch.setPluginEnabled(ID, true, ["evidence.write"]);
      await orch.setupWorkspace(setupInput);

      // submitAnswer → internal recompute (inside the lock) →
      // readinessUpdated enqueued with the changed skill ids
      const start = await orch.startInterview({
        mode: "practice",
        focusSkillId: "distributed-systems.caching",
        plannedQuestions: 1,
      });
      await orch.submitAnswer(
        start.session.id,
        "Cache entries stay consistent with write-through + TTL eviction.",
      );
      await orch.flushPluginEvents();
      const callsAfterAnswer = (await store.getPluginStorageValue(
        ID,
        "readyCalls",
      )) as number;
      expect(callsAfterAnswer).toBeGreaterThanOrEqual(1);
      expect(
        (await store.getPluginStorageValue(ID, "changedIds")) as string[],
      ).toContain("distributed-systems.caching");

      // sessionCompleted is fire-and-forget: completeInterview returns well
      // before the deliberately slow handler finishes
      const t0 = Date.now();
      await orch.completeInterview(start.session.id);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(SLOW_MS - 400);
      expect(await store.getPluginStorageValue(ID, "sessionDone")).toBeUndefined();

      // after the queue drains, the slow handler's effects + payload landed
      await orch.flushPluginEvents();
      expect(await store.getPluginStorageValue(ID, "sessionDone")).toBe(
        start.session.id,
      );
      const scores = (await store.getPluginStorageValue(
        ID,
        "sessionScores",
      )) as Record<string, { meanScore: number; answers: number }>;
      expect(scores["distributed-systems.caching"]).toMatchObject({
        answers: 1,
      });
      expect(scores["distributed-systems.caching"].meanScore).toBeGreaterThan(0);

      // loop guard: event evidence was written (grant held) but the resulting
      // plugin-caused recompute did NOT re-fire readinessUpdated
      const probeEvidence = (await store.listEvidence()).filter(
        (e) => e.source === `plugin:${ID}`,
      );
      expect(probeEvidence.length).toBeGreaterThanOrEqual(1);
      const callsSettled = await store.getPluginStorageValue(ID, "readyCalls");
      await orch.flushPluginEvents();
      expect(await store.getPluginStorageValue(ID, "readyCalls")).toBe(
        callsSettled,
      );
    },
  );
});
