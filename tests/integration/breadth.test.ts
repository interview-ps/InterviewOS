import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inRound } from "@interview-os/core";
import { InterviewOrchestrator, openStore } from "@interview-os/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { jdAnalyzer, registerMockHandlers, taxonomyEntries } from "@interview-os/skills";
import type { SkillContext } from "@interview-os/skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadExample(name: string) {
  const dir = path.join(REPO_ROOT, "examples", name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const companyFile = path.join(dir, "company.md");
  return {
    resumeText: fs.readFileSync(path.join(dir, "resume.md"), "utf8"),
    jobDescription: fs.readFileSync(path.join(dir, "job.md"), "utf8"),
    company: meta.company as string,
    role: meta.role as string,
    level: meta.level as "senior",
    companyNotes: fs.existsSync(companyFile)
      ? fs.readFileSync(companyFile, "utf8")
      : undefined,
  };
}

function makeOrchestrator() {
  const logger = createLogger({ level: "error", sink: () => {} });
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orch = new InterviewOrchestrator({ store, runtime, logger });
  return { orch, store, runtime };
}

describe("interview breadth (§8.4)", () => {
  it("profiles the company and boosts focus-skill requirements", async () => {
    const { orch, store } = makeOrchestrator();
    const ex = loadExample("backend-engineer");
    expect(ex.companyNotes).toBeTruthy();
    const { target } = await orch.setupWorkspace(ex);

    const profile = target.companyProfile!;
    expect(profile).toBeDefined();
    expect(profile.values.length).toBeGreaterThan(0);
    expect(profile.behavioralThemes).toContain("ownership");
    expect(profile.focusSkillIds).toContain("distributed-systems.caching");

    // importance boost = unboosted jd-analyzer value + 0.05, capped at 0.95
    const ctx: SkillContext = {
      runtime: new MockRuntime(),
      logger: createLogger({ level: "error", sink: () => {} }),
      now: () => new Date(),
    };
    registerMockHandlers(ctx.runtime as MockRuntime);
    const base = await jdAnalyzer.execute(
      {
        jobDescription: ex.jobDescription,
        company: ex.company,
        role: ex.role,
        level: ex.level,
        taxonomy: taxonomyEntries(),
      },
      ctx,
    );
    for (const req of [...target.requirements, ...target.preferredSkills]) {
      const baseline = [...base.requirements, ...base.preferredSkills].find(
        (r) => r.skillId === req.skillId,
      )!;
      if (profile.focusSkillIds.includes(req.skillId)) {
        expect(req.boostedBy).toBe("company-profile");
        expect(req.importance).toBeCloseTo(Math.min(0.95, baseline.importance + 0.05), 6);
        expect(req.importance).toBeLessThanOrEqual(0.95);
      } else {
        expect(req.importance).toBeCloseTo(baseline.importance, 6);
      }
    }
    const caching = target.requirements.find(
      (r) => r.skillId === "distributed-systems.caching",
    )!;
    expect(caching.boostedBy).toBe("company-profile");

    // stored on target data
    const row = store.getTarget(target.id)!;
    expect((row.data as { companyProfile?: unknown }).companyProfile).toBeDefined();
  });

  it("behavioral round picks a behavioral/communication skill and STAR-evaluates", async () => {
    const { orch, store } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));

    const start = await orch.startInterview({
      plannedQuestions: 2,
      roundType: "behavioral",
    });
    const q = start.question!;
    expect(inRound(q.skillId, "behavioral")).toBe(true);
    expect(store.getSession(start.session.id)!.roundType).toBe("behavioral");

    const result = await orch.submitAnswer(
      start.session.id,
      "When I was at Acme our team had an outage and I led the fix.",
    );
    expect(result.evaluation.star).not.toBeNull();
    expect(result.evaluation.star!.result).toBe(false);
    const weakness = result.evaluation.weaknesses.find(
      (w) => w.skill === "communication",
    )!;
    expect(weakness.severity).toBe("medium");
    expect(weakness.evidence).toContain("Answer lacked a clear");
    // STAR weakness created a prep action on communication
    const commAction = result.newActions.find((a) => a.skillId === "communication");
    expect(commAction).toBeDefined();
    expect(commAction!.action).toContain("quantified Result");
  });

  it("hr round asks hr.* questions", async () => {
    const { orch } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));
    const start = await orch.startInterview({ plannedQuestions: 1, roundType: "hr" });
    expect(inRound(start.question!.skillId, "hr")).toBe(true);
  });

  it("system_design round asks design-scope questions", async () => {
    const { orch } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));
    const start = await orch.startInterview({
      plannedQuestions: 1,
      roundType: "system_design",
    });
    const id = start.question!.skillId;
    expect(
      id === "system-design" ||
        id.startsWith("system-design.") ||
        id === "distributed-systems" ||
        id.startsWith("distributed-systems."),
    ).toBe(true);
  });

  it("technical round never asks behavioral/hr/system-design questions", async () => {
    const { orch } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));
    const start = await orch.startInterview({ plannedQuestions: 3, roundType: "technical" });
    const session = start.session.id;
    let q = start.question;
    for (let i = 0; i < 3 && q; i++) {
      expect(inRound(q.skillId, "technical")).toBe(true);
      await orch.submitAnswer(session, "I would measure first, then fix the bottleneck.");
      q = (await orch.nextQuestion(session)).question;
    }
  });

  it("generates stories from the resume and coaches them", async () => {
    const { orch, store } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));

    const gen = await orch.generateStories();
    expect(gen.created).toBeGreaterThanOrEqual(1);
    const generated = gen.stories.filter((s) => s.source === "generated");
    expect(generated.length).toBeGreaterThanOrEqual(1);
    expect(generated[0]!.title.length).toBeGreaterThan(0);

    // dedupe: regenerating never duplicates an existing title
    const gen2 = await orch.generateStories();
    const titles = gen2.stories.map((s) => s.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);

    const review = await orch.coachStory(generated[0]!.id);
    expect(review.missing.some((m) => /result/i.test(m))).toBe(true);
    expect(review.improvedDraft.result).toContain("[add metric");

    // edits flip the source to user
    await orch.updateStory(generated[0]!.id, {
      result: "Reduced incident MTTR by 35% quarter over quarter.",
    });
    const updated = store.getStory(generated[0]!.id)!;
    expect(updated.source).toBe("user");
    expect(updated.result).toContain("35%");
  });
});
