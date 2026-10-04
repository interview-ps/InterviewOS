import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLogger } from "@interview-os/core";
import { MockRuntime, RuntimeManager } from "@interview-os/runtime";
import { runPluginWithMock } from "@interview-os/plugin-sdk/testing";
import {
  InterviewOrchestrator,
  McpManager,
  openStore,
} from "@interview-os/server/orchestrator";
import { registerMockHandlers } from "@interview-os/server/skills";
import { createApp } from "../../apps/server/src/http/app.js";
import { loadPlugins } from "../../apps/server/src/startup/plugins.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");
const PACKS_DIR = path.join(REPO_ROOT, "packs");
const CLI = path.join(REPO_ROOT, "packages/plugin-sdk/bin/interview-os.mjs");
const MCP_FIXTURE = path.join(REPO_ROOT, "tests/fixtures/fake-mcp-server.mjs");

const example = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "examples/backend-engineer/meta.json"),
    "utf8",
  ),
) as { company: string; role: string; level: "junior" | "mid" | "senior" | "staff" };
const resumeText = fs.readFileSync(
  path.join(REPO_ROOT, "examples/backend-engineer/resume.md"),
  "utf8",
);
const jobDescription = fs.readFileSync(
  path.join(REPO_ROOT, "examples/backend-engineer/job.md"),
  "utf8",
);

const logger = createLogger({ level: "error", sink: () => {} });
const tmpdir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

function makeOrchestrator(opts: {
  pluginDirs?: { bundled: string; installed: string };
  packDirs?: { bundled: string; installed: string };
  mcpConfig?: string;
} = {}) {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const mcp = opts.mcpConfig
    ? new McpManager(opts.mcpConfig, logger, async (id) => {
        const row = await store.getMcpServer(id);
        return {
          enabled: (row?.enabled ?? 0) === 1,
          allowedTools: (row?.allowedTools as string[] | undefined) ?? [],
        };
      })
    : undefined;
  const orchestrator = new InterviewOrchestrator({
    store,
    runtime,
    logger,
    pluginDirs: opts.pluginDirs,
    packDirs: opts.packDirs,
    mcp,
  });
  return { orchestrator, runtime, store, mcp };
}

function bundledOrch() {
  return makeOrchestrator({
    packDirs: { bundled: PACKS_DIR, installed: tmpdir("ios-packs-inst-") },
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

function gitInit(dir: string) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
    { cwd: dir },
  );
}

describe("v0.4 definition of done (mock)", () => {
  it("runtime selectable through the manager behind PUT /api/runtime", async () => {
    const store = openStore(":memory:");
    const manager = await RuntimeManager.create({
      env: { INTERVIEW_OS_RUNTIME: "mock" },
      logger,
    });
    const orchestrator = new InterviewOrchestrator({
      store,
      runtime: manager,
      logger,
    });
    const app = createApp({
      orchestrator,
      runtime: manager,
      runtimes: manager,
      store,
    });
    const res = await app.request("/api/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "mock" }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).mode).toBe("mock");
  });

  it("installs an external skill from a local git repo, disabled, listed", async () => {
    if (!hasGit()) return;
    const repo = tmpdir("ios-dod-plugin-");
    fs.writeFileSync(
      path.join(repo, "skill.yaml"),
      "id: dod-plugin\nversion: 0.1.0\npermissions: [target.read]\ninputs: [target]\n",
    );
    fs.writeFileSync(
      path.join(repo, "index.js"),
      "export default { execute: (input) => ({ ok: true, company: input.target?.company ?? null }) };\n",
    );
    gitInit(repo);
    const { orchestrator } = makeOrchestrator({
      pluginDirs: { bundled: tmpdir("ios-bundled-"), installed: tmpdir("ios-inst-") },
    });
    await setup(orchestrator);
    const view = await orchestrator.installPluginFromGit(repo);
    expect(view.manifest.id).toBe("dod-plugin");
    expect(view.enabled).toBe(false);
    expect(view.source).toBe("git");
    await orchestrator.setPluginEnabled("dod-plugin", true);
    const { output } = await orchestrator.runPlugin("dod-plugin");
    expect((output as { company: string }).company).toBe(example.company);
  });

  it("permission view lists every category incl. isolation-denied rows", async () => {
    const { orchestrator } = bundledOrch();
    await loadPlugins(PLUGINS_DIR, orchestrator, logger);
    const views = await orchestrator.listPlugins();
    const pg = views.find((v) => v.manifest.id === "postgres-interviewer")!;
    const byCategory = new Map(pg.permissions.map((p) => [p.category, p]));
    for (const denied of ["Local Files", "Network", "Environment/Secrets", "Commands"]) {
      expect(byCategory.get(denied)?.access).toBe("DENIED");
      expect(byCategory.get(denied)?.requested).toBe(false);
    }
    const ev = byCategory.get("Evidence (write)")!;
    expect(ev.requested).toBe(true); // manifest requests evidence.write
    expect(ev.granted).toBe(false); // never auto-granted
    expect(byCategory.get("Target")?.access).toBe("READ");
  });

  it("enable/disable gates run; evidence.write needs an explicit grant", async () => {
    const { orchestrator } = bundledOrch();
    await loadPlugins(PLUGINS_DIR, orchestrator, logger);
    await setup(orchestrator);
    await orchestrator.setPluginEnabled("postgres-interviewer", false);
    await expect(orchestrator.runPlugin("postgres-interviewer")).rejects.toMatchObject({
      code: "PLUGIN_DISABLED",
    });
    // enabling without explicit grants never includes evidence.write
    await orchestrator.setPluginEnabled("postgres-interviewer", true);
    const { evidenceIgnored } = await orchestrator.runPlugin("postgres-interviewer", {
      kind: "questions",
      selfCheck: [{ skillId: "sql", passed: true }],
    });
    expect(evidenceIgnored).toBeGreaterThan(0);
    // granting a permission the manifest never asked for is rejected
    await expect(
      orchestrator.setPluginEnabled("postgres-interviewer", true, ["resume.read"]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("installs a company pack from a local git repo (git on PATH)", async () => {
    if (!hasGit()) return;
    const repo = tmpdir("ios-dod-pack-");
    fs.writeFileSync(
      path.join(repo, "company.yaml"),
      `format: interview-os.company-pack
id: dod-co
name: DodCo
version: 1.0.0
stages:
  - { mode: technical, label: Tech, plannedQuestions: 2, provenance: community }
  - { mode: behavioral, label: Behav, plannedQuestions: 2, provenance: community }
behavioralFramework: { name: X, themes: [], guidance: "" }
`,
    );
    gitInit(repo);
    const { orchestrator } = bundledOrch();
    const { id } = await orchestrator.installPackFromGit("company", repo);
    expect(id).toBe("dod-co");
    const packs = await orchestrator.listPacks();
    expect(packs.companies.map((c) => c.id)).toContain("dod-co");
    // the installed pack resolves as a company profile for its target
    const { target } = await setup(orchestrator, "DodCo");
    expect(target.companyProfileId).toBe("dod-co");
  });

  it("a role pack applies to the active target and adds requirements", async () => {
    const { orchestrator } = bundledOrch();
    const { target } = await setup(orchestrator);
    const applied = await orchestrator.setTargetRolePack(target.id, "backend-engineer");
    expect(applied.target.rolePackId).toBe("backend-engineer");
    expect(
      applied.target.requirements.some(
        (r: { origin?: string }) => r.origin === "role_pack",
      ),
    ).toBe(true);
    const cleared = await orchestrator.setTargetRolePack(target.id, null);
    expect(cleared.target.rolePackId ?? null).toBeNull();
  });

  it("an enabled, listed plugin question source is used verbatim in interviews", async () => {
    const { orchestrator } = bundledOrch();
    await loadPlugins(PLUGINS_DIR, orchestrator, logger);
    await setup(orchestrator);
    await orchestrator.updateSettings({
      questionSources: { plugins: ["postgres-interviewer"] },
    });
    const { session } = await orchestrator.startInterview({
      mode: "practice",
      focusSkillId: "sql.indexing",
    });
    const detail = await orchestrator.getInterview(session!.id);
    expect(detail.questions[0]?.source).toMatchObject({
      kind: "plugin",
      id: "postgres-interviewer",
    });
  });

  it("voice metrics return delivery feedback while evaluation stays identical", async () => {
    const answer =
      "First I designed the schema. Then I built the service. " +
      "Finally I deployed it. As a result latency dropped by 40 percent.";
    // two identical fresh workspaces → identical first question; only voice differs
    const { orchestrator: a } = bundledOrch();
    const { orchestrator: b } = bundledOrch();
    await setup(a);
    await setup(b);
    const s1 = await a.startInterview({ plannedQuestions: 1 });
    const s2 = await b.startInterview({ plannedQuestions: 1 });
    expect(s2.question!.text).toBe(s1.question!.text);

    const voiced = await a.submitAnswer(s1.session!.id, {
      text: answer,
      voice: { durationSec: 200, longPauseCount: 4, longestPauseSec: 9 },
    });
    expect(voiced.voiceFeedback).not.toBeNull();
    expect(voiced.voiceFeedback!.wordCount).toBeGreaterThan(0);
    expect(
      voiced.voiceFeedback!.signals.find((s) => s.id === "pauses")!.status,
    ).toBe("watch");

    const plain = await b.submitAnswer(s2.session!.id, { text: answer });
    expect(plain.voiceFeedback).toBeNull();
    // voice is interaction-layer only: the mock evaluator never sees metrics
    expect(plain.evaluation).toEqual(voiced.evaluation);
  });

  it("MCP fake server: allowlisted tool → stored context → grounded question", async () => {
    const cfg = path.join(tmpdir("ios-mcp-"), "mcp.json");
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        servers: [
          {
            id: "fake",
            name: "Fake MCP",
            command: process.execPath,
            args: [MCP_FIXTURE],
            envPassthrough: [],
          },
        ],
      }),
    );
    const { orchestrator, mcp } = makeOrchestrator({
      packDirs: { bundled: PACKS_DIR, installed: tmpdir("ios-packs-") },
      mcpConfig: cfg,
    });
    await setup(orchestrator);
    const servers = await orchestrator.listMcpServers();
    expect(servers.servers[0]!.enabled).toBe(false); // off by default
    await orchestrator.updateMcpServer("fake", {
      enabled: true,
      allowedTools: ["get_repository"],
    });
    const ctx = await orchestrator.fetchExternalContext({
      serverId: "fake",
      tool: "get_repository",
      args: { repo: "acme/widgets" },
      title: "acme-widgets-repo",
    });
    expect(ctx.text).toContain("acme/widgets");
    const { question } = await orchestrator.startInterview({
      contextId: ctx.id,
      plannedQuestions: 1,
    });
    expect(question!.text).toContain("acme-widgets-repo");
    await mcp!.closeAll();
  });

  it("full export → import roundtrip into a fresh workspace", async () => {
    const { orchestrator: a } = bundledOrch();
    await setup(a);
    const s = await a.startInterview({ plannedQuestions: 1 });
    await a.submitAnswer(s.session!.id, "First I measured. Then I fixed the bottleneck.");
    await a.addUserQuestion({ skillId: "sql", text: "DoD bank question text goes here." });
    const bundle = await a.exportState();
    const histA = (await a.getHistory()).length;

    const { orchestrator: b } = bundledOrch();
    const counts = await b.importState(bundle, { mode: "replace" });
    expect(counts["interviews.sessions"]).toBeGreaterThan(0);
    expect((await b.getHistory()).length).toBe(histA);
    expect((await b.listQuestionBank()).length).toBe(1);
    const stateB = await b.getState();
    expect(stateB.target.role).toBe(example.role);
  });

  it("interview pack create → export → import into another workspace → start", async () => {
    const { orchestrator: a } = bundledOrch();
    await setup(a);
    const created = await a.createInterviewPack({
      name: "DoD Loop",
      skills: ["sql"],
      rounds: [
        { mode: "technical", label: "Tech", plannedQuestions: 1 },
        { mode: "behavioral", label: "Behav", plannedQuestions: 1 },
      ],
      durationMinutes: 45,
    });
    const exported = await a.exportInterviewPack(created.pack.id);
    expect(exported.content).toContain("interview-os.interview-pack");

    const { orchestrator: b } = bundledOrch();
    const imported = await b.importInterviewPack(exported.content);
    expect(imported.source).toBe("imported");
    await setup(b);
    const { loop } = await b.startLoopFromPack(imported.pack.id);
    expect(loop.rounds).toHaveLength(2);
  });

  it("a plugin scaffolded by the CLI validates and runs under runPluginWithMock", async () => {
    const parent = fs.mkdtempSync(path.join(REPO_ROOT, "tests", ".tmp-dod-"));
    try {
      execFileSync(process.execPath, [CLI, "create-skill", "dod-skill", "--dir", parent]);
      const dir = path.join(parent, "dod-skill");
      const out = execFileSync(process.execPath, [CLI, "validate", dir], {
        encoding: "utf8",
      });
      expect(out).toMatch(/ok: dod-skill@0\.1\.0/);

      const plugin = (
        await import(pathToFileURL(path.join(dir, "index.ts")).href)
      ).default;
      const { output } = await runPluginWithMock({
        plugin,
        slices: {
          target: { company: "Acme", role: "Engineer" },
          readiness: { "coding.algorithms": { score: 0.4, label: "Algorithms" } },
        },
      });
      expect((output as { checklist: string[] }).checklist.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("a community plugin dropped into a plugins dir runs isolated, no core change", async () => {
    const bundled = tmpdir("ios-community-");
    const dir = path.join(bundled, "comm-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id: "comm-skill",
        version: "0.1.0",
        kind: "plugin",
        description: "community test plugin",
        permissions: [],
        inputs: [],
        engines: { "interview-os": ">=0.4.0" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "index.js"),
      `export default { execute: () => {
        const traps = [];
        try { traps.push(typeof fetch === "undefined" ? "fetch:gone" : "fetch:present"); } catch { traps.push("fetch:gone"); }
        try { require("fs"); traps.push("require:ok"); } catch (e) { traps.push("require:blocked"); }
        return { env: typeof process === "undefined" ? [] : Object.keys(process.env), traps };
      } };\n`,
    );
    const { orchestrator } = makeOrchestrator({
      pluginDirs: { bundled, installed: tmpdir("ios-inst-") },
    });
    const errors = await loadPlugins(bundled, orchestrator, logger);
    expect(errors).toEqual([]);
    await orchestrator.setPluginEnabled("comm-skill", true);
    const { output } = (await orchestrator.runPlugin("comm-skill")) as {
      output: { env: string[]; traps: string[] };
    };
    // the child gets only the minimal isolation env (no application variables,
    // nothing matching a secret/token name), no fetch, no require escape hatch
    expect(
      output.env.some((k) => /TOKEN|SECRET|PASSWORD|KEY|INTERVIEW|API/i.test(k)),
    ).toBe(false);
    expect(output.traps).toContain("fetch:gone");
    expect(output.traps).toContain("require:blocked");
  });
});
