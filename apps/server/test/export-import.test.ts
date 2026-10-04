import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "../src/orchestrator/index.js";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "../src/skills/index.js";
import { createApp } from "../src/http/app.js";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();
const logger = createLogger({ level: "error", sink: () => {} });

function makeOrchestrator() {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orchestrator = new InterviewOrchestrator({ store, runtime, logger });
  return { orchestrator, runtime, store };
}

/** exportedAt is a fresh timestamp each call — strip it for equality checks. */
async function snapshot(orch: InterviewOrchestrator) {
  const bundle = await orch.exportState();
  return { ...bundle, exportedAt: "<ts>" };
}

async function populate(orch: InterviewOrchestrator) {
  await orch.setupWorkspace({
    resumeText,
    jobDescription,
    company: example.company,
    role: example.role,
    level: example.level,
  });
  // one answered interview question
  const { session } = await orch.startInterview({ plannedQuestions: 1 });
  await orch.submitAnswer(session!.id, {
    text:
      "First I designed the schema. Then I built the service. " +
      "As a result latency dropped by 40 percent.",
  });
  await orch.completeInterview(session!.id);
  // a user story, a bank question, an interview pack
  await orch.generateStories();
  await orch.addUserQuestion({ skillId: "sql.indexing", text: "Explain a covering index in PostgreSQL." });
  await orch.createInterviewPack({
    name: "My Pack",
    description: "test pack",
    skills: ["sql.indexing"],
    rounds: [
      { mode: "technical", label: "Tech", plannedQuestions: 1 },
      { mode: "behavioral", label: "Behav", plannedQuestions: 1 },
    ],
    durationMinutes: 60,
  });
}

describe("export/import (v0.4)", () => {
  it("full roundtrip preserves domain state (plus an 'import' snapshot)", async () => {
    const { orchestrator: a } = makeOrchestrator();
    await populate(a);
    const bundle = await a.exportState();
    expect(bundle.format).toBe("interview-os.export");

    const { orchestrator: b } = makeOrchestrator();
    const counts = await b.importState(bundle, { mode: "replace" });
    expect(counts["interviews.sessions"]).toBe(1);
    expect(counts["candidate.profiles"]).toBe(1);

    const [sa, sb] = [await a.getState(), await b.getState()];
    expect(sb.candidate).toEqual(sa.candidate);
    expect(sb.target).toEqual(sa.target);
    // recompute runs wall-clock decay — scores/evidence are exact, confidence ~equal
    for (const [k, dim] of Object.entries(sa.readiness.dimensions)) {
      const bDim = sb.readiness.dimensions[k]!;
      expect(bDim.score).toBeCloseTo(dim.score ?? 0, 9);
      expect(bDim.evidenceIds).toEqual(dim.evidenceIds);
      expect(bDim.confidence).toBeCloseTo(dim.confidence, 8);
    }
    expect(sb.preparation.nextActions.map((x) => x.id).sort()).toEqual(
      sa.preparation.nextActions.map((x) => x.id).sort(),
    );

    const [ha, hb] = [await a.getHistory(), await b.getHistory()];
    expect(hb.map((h: { session: { id: string } }) => h.session.id)).toEqual(
      ha.map((h) => h.session.id),
    );
    expect(await b.listQuestionBank()).toHaveLength(1);
    expect(
      (await b.listInterviewPacks()).some((p) => p.pack.name === "My Pack"),
    ).toBe(true);

    // import appends an 'import'-reasoned readiness snapshot
    const snaps = (await b.exportState()).readiness.snapshots;
    expect(snaps.length).toBeGreaterThan(bundle.readiness.snapshots.length);
    expect(snaps.some((s) => s.reason === "import")).toBe(true);
  });

  it("rejects an invalid bundle and leaves state untouched", async () => {
    const { orchestrator: a } = makeOrchestrator();
    await populate(a);
    const before = await snapshot(a);
    await expect(
      a.importState({ format: "nope" }, { mode: "replace" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await snapshot(a)).toEqual(before);
  });

  it("rejects dangling references before any write", async () => {
    const { orchestrator: a } = makeOrchestrator();
    await populate(a);
    const bundle = await a.exportState();
    bundle.interviews.questions[0]!.sessionId = "ghost";
    const before = await snapshot(a);
    await expect(a.importState(bundle, { mode: "replace" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await snapshot(a)).toEqual(before);
  });

  it("rolls back the whole import when an insert fails mid-transaction", async () => {
    const { orchestrator: a } = makeOrchestrator();
    await populate(a);
    const bundle = await a.exportState();
    // schema-valid but unserializable in a JSON column → the insert throws
    (bundle.candidate.profiles[0] as { data: unknown }).data = 5n;
    const before = await snapshot(a);
    await expect(a.importState(bundle, { mode: "replace" })).rejects.toThrow();
    expect(await snapshot(a)).toEqual(before);
  });

  it("external contexts roundtrip", async () => {
    const { orchestrator: a, store } = makeOrchestrator();
    await populate(a);
    await store.insertExternalContext({
      id: "ctx_1",
      serverId: "fake",
      tool: "get_repository",
      title: "repo",
      text: "readme text",
      createdAt: new Date().toISOString(),
    });
    const bundle = await a.exportState();
    expect(bundle.externalContexts).toHaveLength(1);
    const { orchestrator: b } = makeOrchestrator();
    await b.importState(bundle, { mode: "replace" });
    const ctxs = await b.listExternalContexts();
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.title).toBe("repo");
  });

  it("excluded tables never appear in the bundle", async () => {
    const { orchestrator: a } = makeOrchestrator();
    await populate(a);
    const keys = Object.keys(await a.exportState());
    for (const banned of [
      "runtime_sessions",
      "runtimeSessions",
      "plugin_installs",
      "pluginInstalls",
      "mcp_servers",
      "mcpServers",
      "usage_events",
      "usageEvents",
    ]) {
      expect(keys).not.toContain(banned);
    }
    expect(keys).toContain("settings");
    expect((await a.exportState()).settings).not.toHaveProperty("runtimeKind");
  });

  it("HTTP: parts endpoint returns the right slice, import requires confirm", async () => {
    const { orchestrator: a, runtime } = makeOrchestrator();
    await populate(a);
    const app = createApp({ orchestrator: a, runtime });

    const part = await json(await app.request("/api/export/candidate"));
    expect(part.profiles).toHaveLength(1);
    const bad = await app.request("/api/export/nope");
    expect(bad.status).toBe(404);

    const full = await app.request("/api/export");
    expect(full.headers.get("content-disposition")).toContain("interview-os-export-");
    const bundle = await json(full);

    const missingConfirm = await app.request("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle }),
    });
    expect(missingConfirm.status).toBe(400);

    const ok = await app.request("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle, confirm: "replace" }),
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).counts["candidate.profiles"]).toBe(1);
  });
});
