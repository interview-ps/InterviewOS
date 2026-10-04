import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "../src/orchestrator/index.js";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger, selectNextSkill, type Requirement } from "@interview-os/core";
import { registerMockHandlers } from "../src/skills/index.js";
import { createApp } from "../src/http/app.js";
import { REPO_ROOT } from "../src/paths.js";
import { loadPlugins } from "../src/startup/plugins.js";

const logger = createLogger({ level: "error", sink: () => {} });
const bundledPacks = path.join(REPO_ROOT, "packs");
const pluginsDir = path.join(REPO_ROOT, "plugins");
const fixtureDir = path.join(REPO_ROOT, "tests/fixtures/plugins");

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

function tmpdir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeOrchestrator(opts: { packDirs?: { bundled: string; installed: string } } = {}) {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orchestrator = new InterviewOrchestrator({
    store,
    runtime,
    logger,
    packDirs: opts.packDirs,
  });
  return { orchestrator, runtime, store };
}

function bundledOrch() {
  return makeOrchestrator({
    packDirs: { bundled: bundledPacks, installed: tmpdir("ios-packs-inst-") },
  });
}

async function setup(orch: InterviewOrchestrator, company = example.company) {
  return orch.setupWorkspace({
    resumeText,
    jobDescription,
    company,
    role: example.role,
    level: example.level,
  });
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("bundled packs (v0.4)", () => {
  it("every bundled pack under packs/ loads with zero errors", async () => {
    const { orchestrator } = bundledOrch();
    const view = await orchestrator.listPacks();
    expect(view.loadErrors).toEqual([]);
    expect(view.companies.map((c) => c.id)).toContain("stripe");
    expect(view.roles.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "backend-engineer",
        "frontend-engineer",
        "product-manager",
        "data-engineer",
        "data-scientist",
        "sre",
        "engineering-manager",
      ]),
    );
    const packs = await orchestrator.listInterviewPacks();
    expect(packs.map((p) => p.pack.id)).toContain("senior-backend");
  });

  it("a Stripe target matches the bundled pack profile", async () => {
    const { orchestrator } = bundledOrch();
    const { target } = await setup(orchestrator, "Stripe");
    expect(target.companyProfileId).toBe("stripe");
  });
});

describe("company guidance provenance (v0.4)", () => {
  function sourcedPackDir(): string {
    const root = tmpdir("ios-packs-src-");
    const dir = path.join(root, "companies", "fixture-co");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "company.yaml"),
      `format: interview-os.company-pack
id: fixture-co
name: FixtureCo
version: 1.0.0
sources:
  - id: blog
    title: FixtureCo Blog
    url: https://example.com/blog
stages:
  - { mode: technical, label: Tech, plannedQuestions: 3, provenance: community }
  - { mode: behavioral, label: Behav, plannedQuestions: 2, provenance: community }
behavioralFramework: { name: X, themes: [], guidance: "" }
competencies:
  - { text: "sourced fact", provenance: sourced, source: blog }
  - { text: "rumor on the street", provenance: community }
`,
    );
    return root;
  }

  it("renders Sourced and Community observation lines", async () => {
    const { orchestrator } = makeOrchestrator({
      packDirs: { bundled: sourcedPackDir(), installed: tmpdir("ios-packs-inst-") },
    });
    const { target } = await setup(orchestrator, "FixtureCo");
    expect(target.companyProfileId).toBe("fixture-co");
    const interview = (orchestrator as unknown as { interview: any }).interview;
    const guidance: string = await interview.companyGuidanceFor(target, "technical");
    expect(guidance).toContain("Sourced (FixtureCo Blog): sourced fact");
    expect(guidance).toContain(
      "Community observation (unverified): rumor on the street",
    );
  });
});

describe("role packs (v0.4)", () => {
  it("adds pack requirements without compounding on re-apply", async () => {
    const { orchestrator, store } = bundledOrch();
    const { target } = await setup(orchestrator);
    const snapshotsBefore = await store.countReadinessSnapshots();
    const first = await orchestrator.setTargetRolePack(target.id, "backend-engineer");
    // applying a role pack appends readiness snapshots (new dims enter scope)
    expect(await store.countReadinessSnapshots()).toBeGreaterThan(snapshotsBefore);
    const reqs = first.target.requirements.filter(
      (r: { origin?: string }) => r.origin === "role_pack",
    );
    expect(reqs.length).toBeGreaterThan(0);
    const sql = first.target.requirements.find(
      (r: { skillId: string }) => r.skillId === "sql",
    );
    expect(sql).toBeDefined();

    const second = await orchestrator.setTargetRolePack(target.id, "backend-engineer");
    const reqs2 = second.target.requirements.filter(
      (r: { origin?: string }) => r.origin === "role_pack",
    );
    expect(reqs2).toHaveLength(reqs.length);
    for (const r of reqs2) {
      const before = reqs.find(
        (x: { skillId: string }) => x.skillId === r.skillId,
      );
      expect(r.importance).toBe(before?.importance);
    }

    // clearing removes pack requirements
    const cleared = await orchestrator.setTargetRolePack(target.id, null);
    expect(
      cleared.target.requirements.filter(
        (r: { origin?: string }) => r.origin === "role_pack",
      ),
    ).toHaveLength(0);
  });

  it("defaults loop rounds from the role pack when profile is generic", async () => {
    const { orchestrator } = bundledOrch();
    const { target } = await setup(orchestrator, "SomeCo With No Profile");
    expect(target.companyProfileId ?? "generic").toBe("generic");
    await orchestrator.setTargetRolePack(target.id, "backend-engineer");
    const { loop } = (await orchestrator.startLoop()) as {
      loop: { rounds: { mode: string }[] };
    };
    expect(loop.rounds.map((r) => r.mode)).toEqual([
      "technical",
      "coding",
      "system_design",
      "behavioral",
    ]);
  });
});

describe("interview packs (v0.4)", () => {
  const input = {
    name: "My Loop",
    skills: ["sql"],
    rounds: [
      { mode: "technical" as const, label: "Tech", plannedQuestions: 2 },
      { mode: "behavioral" as const, label: "Behav", plannedQuestions: 2 },
    ],
    durationMinutes: 60,
  };

  it("creates, exports, imports roundtrip, and handles conflicts", async () => {
    const { orchestrator } = bundledOrch();
    const created = await orchestrator.createInterviewPack(input);
    expect(created.pack.id).toBe("my-loop");

    const exported = await orchestrator.exportInterviewPack("my-loop");
    expect(exported.filename).toBe("my-loop-1.0.0.interview-pack.yaml");
    expect(exported.content).toContain("interview-os.interview-pack");

    await orchestrator.deleteInterviewPack("my-loop");
    const imported = await orchestrator.importInterviewPack(exported.content);
    expect(imported.pack.id).toBe("my-loop");
    expect(imported.source).toBe("imported");

    // same id + same version conflicts
    await expect(
      orchestrator.importInterviewPack(exported.content),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // bundled ids are read-only
    await expect(
      orchestrator.importInterviewPack(
        exported.content.replace(/^id: my-loop$/m, "id: senior-backend"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      orchestrator.deleteInterviewPack("senior-backend"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("startLoopFromPack sets focus skills and pack id on the loop", async () => {
    const { orchestrator, store } = bundledOrch();
    await setup(orchestrator);
    const { loop } = (await orchestrator.startLoopFromPack("senior-backend")) as {
      loop: { id: string; rounds: { mode: string }[] };
    };
    expect(loop.rounds.map((r) => r.mode)).toEqual([
      "technical",
      "coding",
      "system_design",
      "behavioral",
    ]);
    const row = await store.getLoop(loop.id);
    expect(row?.packId).toBe("senior-backend");
    expect(row?.focusSkills).toEqual(
      expect.arrayContaining(["distributed-systems", "sql", "apis", "system-design"]),
    );
  });
});

describe("question sources (v0.4)", () => {
  async function practiceSession(orch: InterviewOrchestrator, skillId: string) {
    const { session } = await orch.startInterview({
      mode: "practice",
      focusSkillId: skillId,
    });
    return session;
  }

  it("user-bank questions are used verbatim, recorded, and not reused", async () => {
    const { orchestrator } = bundledOrch();
    await setup(orchestrator);
    const text = "Explain WAL versus shared_buffers tuning in PostgreSQL.";
    await orchestrator.addUserQuestion({ skillId: "sql", text });
    const session = await practiceSession(orchestrator, "sql");
    // first question (from startInterview) consumes the bank item
    const detail = await orchestrator.getInterview(session!.id);
    expect(detail.questions[0]?.text).toBe(text);
    expect(detail.questions[0]?.source).toMatchObject({ kind: "user_bank" });

    await orchestrator.submitAnswer(session!.id, "WAL is the log.");
    const next = await orchestrator.nextQuestion(session!.id);
    expect(next.question?.text).not.toBe(text);
  });

  it("disabled sources are not used", async () => {
    const { orchestrator } = bundledOrch();
    await setup(orchestrator);
    const text = "User-bank question that must never be picked when disabled.";
    await orchestrator.addUserQuestion({ skillId: "sql", text });
    await orchestrator.updateSettings({ questionSources: { userBank: false } });
    const session = await practiceSession(orchestrator, "sql");
    const detail = await orchestrator.getInterview(session!.id);
    expect(detail.questions[0]?.text).not.toBe(text);
    expect(detail.questions[0]?.source).toBeNull();
  });

  it("plugin question source only runs when listed and enabled", async () => {
    const { orchestrator } = bundledOrch();
    await loadPlugins(pluginsDir, orchestrator, logger);
    await setup(orchestrator);

    // not listed in settings.plugins → not used
    const s1 = await practiceSession(orchestrator, "sql.indexing");
    const d1 = await orchestrator.getInterview(s1!.id);
    expect(d1.questions[0]?.source?.kind ?? null).not.toBe("plugin");

    await orchestrator.updateSettings({
      questionSources: { plugins: ["postgres-interviewer"] },
    });
    const s2 = await practiceSession(orchestrator, "sql.indexing");
    const d2 = await orchestrator.getInterview(s2!.id);
    expect(d2.questions[0]?.source).toMatchObject({
      kind: "plugin",
      id: "postgres-interviewer",
    });

    // disabled again → not used even though listed
    await orchestrator.setPluginEnabled("postgres-interviewer", false);
    const s3 = await practiceSession(orchestrator, "sql.indexing");
    const d3 = await orchestrator.getInterview(s3!.id);
    expect(d3.questions[0]?.source).toBeNull();
  });

  it("a failing plugin source falls back to generated questions", async () => {
    const { orchestrator } = bundledOrch();
    await loadPlugins(fixtureDir, orchestrator, logger);
    await setup(orchestrator);
    await orchestrator.updateSettings({
      questionSources: { plugins: ["failing-questions"] },
    });
    const session = await practiceSession(orchestrator, "sql");
    const detail = await orchestrator.getInterview(session!.id);
    expect(detail.questions[0]?.text).toBeTruthy();
    expect(detail.questions[0]?.source).toBeNull();
  });
});

describe("learning resources (v0.4)", () => {
  it("plan actions carry builtin resources and plugin resources merge in", async () => {
    const { orchestrator } = bundledOrch();
    await loadPlugins(pluginsDir, orchestrator, logger);
    await orchestrator.setPluginEnabled("learning-resources", true);
    const { actions } = await setup(orchestrator);
    expect(actions.length).toBeGreaterThan(0);
    const action = actions[0]!;
    expect(Array.isArray(action.resources)).toBe(true);
    expect(action.resources.some((r: { source: string }) => r.source === "builtin")).toBe(
      true,
    );

    const updated = await orchestrator.fetchPluginResources(action.id);
    expect(
      updated.resources.some((r: { source: string }) =>
        r.source === "plugin:learning-resources",
      ),
    ).toBe(true);
  });
});

describe("pack install from git (v0.4)", () => {
  it("installs a company pack from a local repo and uninstalls it", async () => {
    if (!hasGit()) return;
    const repo = tmpdir("ios-pack-repo-");
    fs.writeFileSync(
      path.join(repo, "company.yaml"),
      `format: interview-os.company-pack
id: gitco
name: GitCo
version: 1.0.0
stages:
  - { mode: technical, label: Tech, plannedQuestions: 3, provenance: community }
  - { mode: behavioral, label: Behav, plannedQuestions: 2, provenance: community }
behavioralFramework: { name: X, themes: [], guidance: "" }
`,
    );
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
      { cwd: repo },
    );
    const { orchestrator } = bundledOrch();
    const { id } = await orchestrator.installPackFromGit("company", repo);
    expect(id).toBe("gitco");
    const view = await orchestrator.listPacks();
    expect(view.companies.map((c) => c.id)).toContain("gitco");
    await orchestrator.uninstallPack("company", "gitco");
    const after = await orchestrator.listPacks();
    expect(after.companies.map((c) => c.id)).not.toContain("gitco");
  });
});

describe("pack HTTP routes (v0.4)", () => {
  it("smoke: all new endpoints respond", async () => {
    const { orchestrator, runtime } = bundledOrch();
    const app = createApp({ orchestrator, runtime });

    const packs = await json(await app.request("/api/packs"));
    expect(packs.companies.length).toBeGreaterThan(0);
    expect(packs.loadErrors).toEqual([]);

    const bad = await app.request("/api/packs/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "company", url: "ssh://x@y/z" }),
    });
    expect(bad.status).toBe(400);

    const list = await json(await app.request("/api/interview-packs"));
    expect(list.some((p: { pack: { id: string } }) => p.pack.id === "senior-backend")).toBe(
      true,
    );

    const created = await app.request("/api/interview-packs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "API Pack",
        skills: ["sql"],
        rounds: [
          { mode: "technical", label: "T", plannedQuestions: 2 },
          { mode: "behavioral", label: "B", plannedQuestions: 2 },
        ],
        durationMinutes: 45,
      }),
    });
    expect(created.status).toBe(201);

    const exp = await app.request("/api/interview-packs/api-pack/export");
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toContain("attachment");
    const yamlText = await exp.text();
    const imp = await app.request("/api/interview-packs/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: yamlText }),
    });
    expect(imp.status).toBe(409);

    const del = await app.request("/api/interview-packs/api-pack", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const bank = await app.request("/api/question-bank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillId: "sql",
        text: "What is a covering index?",
      }),
    });
    expect(bank.status).toBe(201);
    const bankBody = await json(bank);
    const bankList = await json(await app.request("/api/question-bank"));
    expect(bankList.length).toBe(1);
    const delQ = await app.request(`/api/question-bank/${bankBody.id}`, {
      method: "DELETE",
    });
    expect(delQ.status).toBe(200);

    const impQ = await app.request("/api/question-bank/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `- skillId: sql\n  text: "Difference between DELETE and TRUNCATE?"`,
      }),
    });
    expect(impQ.status).toBe(201);
  });

  it("PUT /api/targets/:id/role-pack assigns and clears a pack", async () => {
    const { orchestrator, runtime } = bundledOrch();
    const { target } = await setup(orchestrator);
    const app = createApp({ orchestrator, runtime });
    const put = await app.request(`/api/targets/${target.id}/role-pack`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rolePackId: "backend-engineer" }),
    });
    expect(put.status).toBe(200);
    const body = await json(put);
    expect(body.target.rolePackId).toBe("backend-engineer");
  });
});
