import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "../src/orchestrator/index.js";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "../src/skills/index.js";
import { REPO_ROOT } from "../src/paths.js";

const example = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "examples/backend-engineer/meta.json"), "utf8"),
) as { company: string; role: string; level: "junior" | "mid" | "senior" | "staff" };
const resumeText = fs.readFileSync(
  path.join(REPO_ROOT, "examples/backend-engineer/resume.md"),
  "utf8",
);
const jobDescription = fs.readFileSync(
  path.join(REPO_ROOT, "examples/backend-engineer/job.md"),
  "utf8",
);

function makeOrchestrator() {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  return new InterviewOrchestrator({ store, runtime, logger: createLogger({ level: "error", sink: () => {} }) });
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

const ANSWER =
  "First I designed the schema. Then I built the service. " +
  "Finally I deployed it. As a result latency dropped by 40 percent.";

describe("voice mode (v0.4)", () => {
  it("submitAnswer stores metrics+feedback and returns feedback; evaluation unchanged", async () => {
    const orch = makeOrchestrator();
    await setup(orch);
    const { session } = await orch.startInterview({ plannedQuestions: 1 });
    const res = await orch.submitAnswer(session!.id, {
      text: ANSWER,
      voice: { durationSec: 200, longPauseCount: 4, longestPauseSec: 2 },
    });
    expect(res.voiceFeedback).not.toBeNull();
    expect(res.voiceFeedback!.wordCount).toBeGreaterThan(0);
    // >180s and >=3 long pauses → watch signals
    expect(res.voiceFeedback!.signals.find((s) => s.id === "length")!.status).toBe("watch");
    expect(res.voiceFeedback!.signals.find((s) => s.id === "pauses")!.status).toBe("watch");
    // evaluation/evidence still produced normally
    expect(res.evaluation).toBeTruthy();
    expect(res.skillImpact.length).toBeGreaterThan(0);

    const detail = await orch.getInterview(session!.id);
    const answer = detail.answers.find((a) => a.questionId === detail.questions[0]!.id);
    expect((answer?.voice as { metrics: { durationSec: number } }).metrics.durationSec).toBe(200);
    expect((answer?.voice as { feedback: { wordCount: number } }).feedback.wordCount).toBe(
      res.voiceFeedback!.wordCount,
    );

    const history = await orch.getSessionHistory(session!.id);
    expect(
      (history.questions[0]!.answer as { voice: { metrics: { durationSec: number } } })
        .voice.metrics.durationSec,
    ).toBe(200);
  });

  it("no voice input → voiceFeedback null, voice column null", async () => {
    const orch = makeOrchestrator();
    await setup(orch);
    const { session } = await orch.startInterview({ plannedQuestions: 1 });
    const res = await orch.submitAnswer(session!.id, { text: ANSWER });
    expect(res.voiceFeedback).toBeNull();
    const detail = await orch.getInterview(session!.id);
    expect(detail.answers[0]!.voice).toBeNull();
  });

  it("voice settings default and partial update", async () => {
    const orch = makeOrchestrator();
    const s = await orch.getSettings();
    expect(s.voice).toEqual({ enabled: false, speakQuestions: true });
    const updated = await orch.updateSettings({ voice: { enabled: true } });
    expect(updated.voice).toEqual({ enabled: true, speakQuestions: true });
  });
});
