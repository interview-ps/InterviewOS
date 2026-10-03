import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "@interview-os/server/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "@interview-os/server/skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadExample(name: string) {
  const dir = path.join(REPO_ROOT, "examples", name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  return {
    resumeText: fs.readFileSync(path.join(dir, "resume.md"), "utf8"),
    jobDescription: fs.readFileSync(path.join(dir, "job.md"), "utf8"),
    company: meta.company as string,
    role: meta.role as string,
    level: meta.level as "senior",
  };
}

describe("multiple targets (§8.1)", () => {
  it("adds a second target, shares evidence, keeps plans scoped per target", async () => {
    const logger = createLogger({ level: "error", sink: () => {} });
    const runtime = new MockRuntime();
    registerMockHandlers(runtime);
    const store = openStore(":memory:");
    const orch = new InterviewOrchestrator({ store, runtime, logger });

    const setup = await orch.setupWorkspace(loadExample("backend-engineer"));
    const target1Id = setup.target.id;
    const state1 = await orch.getState();
    const actions1 = state1.preparation.nextActions;
    expect(actions1.length).toBeGreaterThan(0);
    const python1 = (await orch.getSkillDetail("python")).readiness!.score;
    const gaps1 = state1.assessment.gaps.map((g) => g.skillId);

    // second target: the same candidate now aims at the data-engineer role
    const de = loadExample("data-engineer");
    const added = await orch.addTarget({
      jobDescription: de.jobDescription,
      company: de.company,
      role: de.role,
      level: de.level,
    });
    expect(added.target.id).not.toBe(target1Id);
    expect(added.actions.length).toBeGreaterThan(0);

    const targets = await orch.listTargets();
    expect(targets.length).toBe(2);
    expect(targets.find((t) => t.id === added.target.id)!.active).toBe(true);
    expect(targets.find((t) => t.id === target1Id)!.active).toBe(false);

    // evidence/readiness is candidate-level and shared across targets
    const python2 = (await orch.getSkillDetail("python")).readiness!.score;
    expect(python2).toBeCloseTo(python1!, 10);

    // gaps and the plan differ for the new target
    const state2 = await orch.getState();
    const gaps2 = state2.assessment.gaps.map((g) => g.skillId);
    expect(gaps2).not.toEqual(gaps1);
    const actionIds2 = new Set(state2.preparation.nextActions.map((a) => a.id));
    expect(actions1.every((a) => !actionIds2.has(a.id))).toBe(true);

    // switching back restores target 1 and its original open actions
    const back = await orch.activateTarget(target1Id);
    expect(back.target.id).toBe(target1Id);
    expect(back.actions.length).toBeGreaterThan(0);
    const stateBack = await orch.getState();
    expect(stateBack.target.id).toBe(target1Id);
    const openIds = new Set(stateBack.preparation.nextActions.map((a) => a.id));
    for (const a of actions1) {
      if (a.status === "open" || a.status === "in_progress") {
        expect(openIds.has(a.id)).toBe(true);
      }
    }
    expect((await orch.listTargets()).find((t) => t.id === target1Id)!.active).toBe(true);

    // activating a target with no open actions rebuilds its plan
    const back2 = await orch.activateTarget(added.target.id);
    expect(back2.actions.length).toBeGreaterThan(0);
  }, 60_000);
});
