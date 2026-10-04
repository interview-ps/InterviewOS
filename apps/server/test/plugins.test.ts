import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "../src/orchestrator/index.js";
import { MockRuntime } from "@interview-os/runtime";
import { SkillManifestSchema, createLogger } from "@interview-os/core";
import { registerMockHandlers } from "../src/skills/index.js";
import { createIsolatedExecutor } from "../src/plugins/index.js";
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

function makeOrchestrator(pluginDirs?: { bundled: string; installed: string }) {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orchestrator = new InterviewOrchestrator({
    store,
    runtime,
    logger,
    pluginDirs,
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

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("plugin loader (§9.6)", () => {
  it("rejects a plugin requesting non-evidence write permissions", async () => {
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
    const { output } = (await orchestrator.runPlugin("target-only")) as {
      output: {
        keys: string[];
        hasCandidate: boolean;
        target: { company: string } | null;
        runtimeError: string | null;
      };
    };
    // target-only declares only `target` — candidate must never be assembled
    expect(output.keys).toEqual(["target"]);
    expect(output.hasCandidate).toBe(false);
    expect(output.target?.company).toBe(example.company);
    expect(output.runtimeError).toBe("PERMISSION_DENIED");
  });

  it("sample interview-day-checklist loads and produces checklist items", async () => {
    const { orchestrator } = makeOrchestrator();
    const errors = await loadPlugins(pluginsDir, orchestrator, logger);
    expect(errors).toEqual([]);
    const manifest = orchestrator
      .listSkillManifests()
      .find((m) => m.id === "interview-day-checklist");
    expect(manifest?.kind).toBe("plugin");
    // "checklist" was migrated to the normalized "preparation" capability.
    expect(manifest?.capabilities).toEqual(["preparation"]);
    await setup(orchestrator);
    const { output } = (await orchestrator.runPlugin("interview-day-checklist")) as {
      output: { title: string; items: { title: string }[] };
    };
    expect(output.items.length).toBeGreaterThanOrEqual(4);
    expect(output.items.some((i) => i.title === "STAR reminder")).toBe(true);
  });

  it("postgres-interviewer (SDK + skill.yaml) loads and runs", async () => {
    const { orchestrator } = makeOrchestrator();
    const errors = await loadPlugins(pluginsDir, orchestrator, logger);
    expect(errors).toEqual([]);
    const manifest = orchestrator
      .listSkillManifests()
      .find((m) => m.id === "postgres-interviewer");
    expect(manifest?.name).toBe("PostgreSQL Interviewer");
    await setup(orchestrator);
    const { output } = (await orchestrator.runPlugin("postgres-interviewer", {
      skillId: "sql.indexing",
    })) as { output: { questions: { skillId: string }[] } };
    expect(output.questions.length).toBeGreaterThan(0);
    expect(output.questions.every((q) => q.skillId === "sql.indexing")).toBe(true);
  });
});

describe("plugin isolation (v0.4)", () => {
  it("cannot read files outside its directory", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const { output } = (await orchestrator.runPlugin("fs-escape")) as {
      output: { escaped: boolean; code: string };
    };
    expect(output.escaped).toBe(false);
    expect(output.code).toBe("ERR_ACCESS_DENIED");
  });

  it("has no fetch and cannot import node:http", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const { output } = (await orchestrator.runPlugin("net-escape")) as {
      output: { fetchType: string; httpErr: string };
    };
    expect(output.fetchType).toBe("undefined");
    expect(output.httpErr).toBe("BLOCKED");
  });

  it("sees an empty environment", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const { output } = (await orchestrator.runPlugin("env-leak")) as {
      output: { envKeys: string[] };
    };
    // Windows injects a fixed set of system vars into every child; none of the
    // parent's application env may leak through.
    const WINDOWS_NOISE = new Set([
      "SystemRoot",
      "windir",
      "WINDIR",
      "SYSTEMDRIVE",
      "HOMEDRIVE",
      "HOMEPATH",
      "LOGONSERVER",
      "PATH",
      "TEMP",
      "TMP",
      "USERDOMAIN",
      "USERNAME",
      "USERPROFILE",
      "COMSPEC",
      "PATHEXT",
      "OS",
    ]);
    const leaked = output.envKeys.filter(
      (k) => !WINDOWS_NOISE.has(k) && !k.startsWith("PROCESSOR"),
    );
    expect(leaked).toEqual([]);
    expect(output.envKeys.some((k) => k.startsWith("INTERVIEW_OS"))).toBe(false);
  });

  it("times out a plugin that never resolves", async () => {
    const { orchestrator } = makeOrchestrator();
    const manifest = SkillManifestSchema.parse(
      JSON.parse(
        fs.readFileSync(path.join(fixtureDir, "slow/manifest.json"), "utf8"),
      ),
    );
    orchestrator.registerPlugin(
      manifest,
      createIsolatedExecutor({
        pluginDir: path.join(fixtureDir, "slow"),
        entryFile: "index.js",
        manifest,
        logger,
        timeoutMs: 1000,
      }),
    );
    await expect(orchestrator.runPlugin("slow")).rejects.toMatchObject({
      code: "PLUGIN_TIMEOUT",
    });
  });

  it("bridges runtime.invoke runTask over IPC", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    runtime.register("plugin-fixture-task", () => ({ echo: "pong" }));
    await loadPlugins(fixtureDir, orchestrator, logger);
    const { output } = (await orchestrator.runPlugin("runtime-user")) as {
      output: { ran: boolean; ok: boolean; output: { echo: string } };
    };
    expect(output).toEqual({ ran: true, ok: true, output: { echo: "pong" } });
  });
});

describe("plugin lifecycle (v0.4)", () => {
  it("rejects runs while disabled (PLUGIN_DISABLED) and re-enables", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    await orchestrator.setPluginEnabled("target-only", false);
    await expect(orchestrator.runPlugin("target-only")).rejects.toMatchObject({
      code: "PLUGIN_DISABLED",
    });
    const view = await orchestrator.setPluginEnabled("target-only", true);
    expect(view.enabled).toBe(true);
    expect(view.grantedPermissions).toEqual(["target.read"]);
    await setup(orchestrator);
    const { output } = await orchestrator.runPlugin("target-only");
    expect((output as { keys: string[] }).keys).toEqual(["target"]);
  });

  it("rejects grants outside the manifest", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    await expect(
      orchestrator.setPluginEnabled("target-only", true, ["stories.read"]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("lists plugins with permission views and compatibility", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const views = await orchestrator.listPlugins();
    const target = views.find((v) => v.manifest.id === "target-only");
    expect(target?.enabled).toBe(true);
    expect(target?.compatible).toBe(true);
    expect(
      target?.permissions.find((p) => p.category === "Target"),
    ).toMatchObject({ access: "READ", requested: true, granted: true });
    expect(
      target?.permissions.find((p) => p.category === "Local Files"),
    ).toMatchObject({ access: "DENIED" });
  });

  it("marks incompatible engines as listed-but-not-runnable", async () => {
    const { orchestrator } = makeOrchestrator();
    const manifest = SkillManifestSchema.parse({
      id: "future-plugin",
      version: "1.0.0",
      kind: "plugin",
      permissions: [],
      engines: { "interview-os": ">=99.0.0" },
    });
    orchestrator.registerPlugin(manifest, { execute: () => ({ ok: true }) });
    const views = await orchestrator.listPlugins();
    expect(views.find((v) => v.manifest.id === "future-plugin")?.compatible).toBe(
      false,
    );
    await expect(orchestrator.runPlugin("future-plugin")).rejects.toMatchObject({
      code: "PLUGIN_INCOMPATIBLE",
    });
  });

  it("findPluginsByCapability returns enabled compatible plugins only", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    const found = await orchestrator.findPluginsByCapability("question_source");
    expect(found.map((m) => m.id)).toContain("postgres-interviewer");
    await orchestrator.setPluginEnabled("postgres-interviewer", false);
    const after = await orchestrator.findPluginsByCapability("question_source");
    expect(after.map((m) => m.id)).not.toContain("postgres-interviewer");
  });
});

describe("plugin evidence proposals (v0.4)", () => {
  it("ignores proposals without an evidence.write grant", async () => {
    const { orchestrator, store } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    await setup(orchestrator);
    const result = await orchestrator.runPlugin("evidence-writer");
    expect(result.evidenceWritten).toBe(0);
    expect(result.evidenceIgnored).toBe(2);
    const rows = await store.listEvidence();
    expect(rows.filter((r) => r.type === "plugin")).toHaveLength(0);
  });

  it("persists capped proposals once evidence.write is granted", async () => {
    const { orchestrator, store } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    await setup(orchestrator);
    await orchestrator.setPluginEnabled("evidence-writer", true, [
      "evidence.write",
    ]);
    const before = await store.countReadinessSnapshots();
    const result = await orchestrator.runPlugin("evidence-writer");
    expect(result.evidenceWritten).toBe(2);
    expect(result.evidenceIgnored).toBe(0);

    const rows = (await store.listEvidence()).filter(
      (r) => r.type === "plugin",
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "plugin:evidence-writer")).toBe(true);
    expect(rows.every((r) => r.observation.startsWith("[plugin:evidence-writer]"))).toBe(
      true,
    );
    // proposed confidence 0.9 is capped at 0.6
    expect(Math.max(...rows.map((r) => r.confidence))).toBeLessThanOrEqual(0.6);
    const after = await store.countReadinessSnapshots();
    expect(after).toBeGreaterThan(before);
  });

  it("rejects invalid proposals but still returns the run output", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    await setup(orchestrator);
    await orchestrator.setPluginEnabled("evidence-invalid", true, [
      "evidence.write",
    ]);
    const result = await orchestrator.runPlugin("evidence-invalid");
    expect(result.evidenceRejected).toBeDefined();
    expect(result.evidenceWritten).toBe(0);
    expect((result.output as { ok: boolean }).ok).toBe(true);
  });
});

describe("plugin install/uninstall (v0.4)", () => {
  function gitRepoWithPlugin(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-plugin-repo-"));
    fs.writeFileSync(
      path.join(dir, "skill.yaml"),
      `id: git-plugin
version: 0.1.0
permissions: [target.read]
inputs: [target]
`,
    );
    fs.writeFileSync(
      path.join(dir, "index.js"),
      `export default { execute: (input) => ({ from: "git", hasTarget: input.target != null }) };\n`,
    );
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
      { cwd: dir },
    );
    return dir;
  }

  it("installs from a local git repo, registers, and uninstalls", async () => {
    if (!hasGit()) return; // git not on PATH
    const repo = gitRepoWithPlugin();
    const installed = fs.mkdtempSync(path.join(os.tmpdir(), "ios-installed-"));
    const bundled = fs.mkdtempSync(path.join(os.tmpdir(), "ios-bundled-"));
    const { orchestrator } = makeOrchestrator({ bundled, installed });
    await setup(orchestrator);

    const view = await orchestrator.installPluginFromGit(repo);
    expect(view.manifest.id).toBe("git-plugin");
    expect(view.enabled).toBe(false); // git installs start disabled
    expect(fs.existsSync(path.join(installed, "git-plugin", "index.js"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(installed, "git-plugin", ".git"))).toBe(false);

    // dynamic registration: listed without restart
    const views = await orchestrator.listPlugins();
    expect(views.find((v) => v.manifest.id === "git-plugin")).toBeDefined();

    await orchestrator.setPluginEnabled("git-plugin", true);
    const { output } = await orchestrator.runPlugin("git-plugin");
    expect((output as { from: string }).from).toBe("git");

    // collision: reinstall same id fails
    await expect(orchestrator.installPluginFromGit(repo)).rejects.toMatchObject({
      code: "PLUGIN_INSTALL",
    });

    await orchestrator.uninstallPlugin("git-plugin");
    expect(fs.existsSync(path.join(installed, "git-plugin"))).toBe(false);
    await expect(orchestrator.runPlugin("git-plugin")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses to uninstall bundled plugins", async () => {
    const { orchestrator } = makeOrchestrator({
      bundled: pluginsDir,
      installed: fs.mkdtempSync(path.join(os.tmpdir(), "ios-installed-")),
    });
    await loadPlugins(pluginsDir, orchestrator, logger);
    await expect(
      orchestrator.uninstallPlugin("interview-day-checklist"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects urls with credentials or non-https schemes", async () => {
    const { orchestrator } = makeOrchestrator({
      bundled: pluginsDir,
      installed: fs.mkdtempSync(path.join(os.tmpdir(), "ios-installed-")),
    });
    await expect(
      orchestrator.installPluginFromGit("https://user:pw@example.com/x.git"),
    ).rejects.toMatchObject({ code: "PLUGIN_INSTALL" });
    await expect(
      orchestrator.installPluginFromGit("ssh://git@example.com/x.git"),
    ).rejects.toMatchObject({ code: "PLUGIN_INSTALL" });
    await expect(
      orchestrator.installPluginFromGit("--upload-pack=/bin/sh"),
    ).rejects.toMatchObject({ code: "PLUGIN_INSTALL" });
  });
});

describe("plugin isolation hardening (v0.4 rework)", () => {
  it("a child that only logs then exits settles on close, not the timeout", async () => {
    const { orchestrator } = makeOrchestrator();
    const manifest = SkillManifestSchema.parse(
      JSON.parse(
        fs.readFileSync(path.join(fixtureDir, "log-exit/manifest.json"), "utf8"),
      ),
    );
    orchestrator.registerPlugin(
      manifest,
      createIsolatedExecutor({
        pluginDir: path.join(fixtureDir, "log-exit"),
        entryFile: "index.js",
        manifest,
        logger,
        timeoutMs: 8000,
      }),
    );
    const started = Date.now();
    await expect(orchestrator.runPlugin("log-exit")).rejects.toMatchObject({
      code: "PLUGIN_OUTPUT",
    });
    expect(Date.now() - started).toBeLessThan(7000);
  });

  it("denies runTask when runtime.invoke was requested but not granted", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    // grant nothing: runtime.invoke requested by the manifest, not granted
    await orchestrator.setPluginEnabled("runtime-user", true, []);
    await expect(orchestrator.runPlugin("runtime-user")).rejects.toMatchObject({
      code: "PLUGIN_OUTPUT",
    });
    // the server survived — another plugin still runs fine afterwards
    await setup(orchestrator);
    const { output } = (await orchestrator.runPlugin("target-only")) as {
      output: { keys: string[] };
    };
    expect(output.keys).toEqual(["target"]);
  });

  it("process.binding/_linkedBinding/dlopen are unavailable to plugin code", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const { output } = (await orchestrator.runPlugin("binding-probe")) as {
      output: { binding: string; linked: string; dlopen: string };
    };
    expect(output.binding).not.toBe("ALLOWED");
    expect(output.linked).not.toBe("ALLOWED");
    expect(output.dlopen).not.toBe("ALLOWED");
  });

  it("node:module/node:wasi/node:repl cannot be imported by plugin code", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const { output } = (await orchestrator.runPlugin("module-bypass")) as {
      output: Record<string, string>;
    };
    for (const v of Object.values(output)) {
      expect(v).not.toBe("ALLOWED");
    }
  });

  it("data: URL modules cannot pull in node:net", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const { output } = (await orchestrator.runPlugin("data-import")) as {
      output: { dataNet: string };
    };
    expect(output.dataNet).not.toBe("ALLOWED");
  });

  it("createRequire-based requires stay blocked", async () => {
    const { orchestrator } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const { output } = (await orchestrator.runPlugin("create-require")) as {
      output: { requireNet: string };
    };
    expect(output.requireNet).not.toBe("ALLOWED");
  });
});

describe("plugin id safety (v0.4 rework)", () => {
  it("registerPlugin rejects a path-traversal id", () => {
    const { orchestrator } = makeOrchestrator();
    const manifest = SkillManifestSchema.parse({
      id: "../evil",
      version: "1.0.0",
      kind: "plugin",
      permissions: [],
    });
    expect(() =>
      orchestrator.registerPlugin(manifest, { execute: () => ({}) }),
    ).toThrow(/slug|id/);
  });

  it("install from a local git repo with a traversal id writes nothing outside", async () => {
    if (!hasGit()) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-evil-repo-"));
    fs.writeFileSync(
      path.join(dir, "skill.yaml"),
      `id: "../evil"\nversion: 0.1.0\npermissions: []\n`,
    );
    fs.writeFileSync(
      path.join(dir, "index.js"),
      `export default { execute: () => ({ ok: true }) };\n`,
    );
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
      { cwd: dir },
    );
    const installed = fs.mkdtempSync(path.join(os.tmpdir(), "ios-installed-"));
    const { orchestrator } = makeOrchestrator({
      bundled: fs.mkdtempSync(path.join(os.tmpdir(), "ios-bundled-")),
      installed,
    });
    await expect(
      orchestrator.installPluginFromGit(dir),
    ).rejects.toMatchObject({ code: "PLUGIN_INSTALL" });
    // nothing may have landed outside the install dir (or anywhere)
    expect(fs.readdirSync(installed)).toEqual([]);
    expect(
      fs.existsSync(path.join(installed, "..", "evil")),
    ).toBe(false);
  });
});

describe("plugin HTTP routes (v0.4)", () => {
  it("GET /api/skills lists built-ins, plugins, capabilities and load errors", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    const errors = await loadPlugins(fixtureDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime, pluginErrors: errors });
    const body = await json(await app.request("/api/skills"));
    const kinds = new Map(
      body.skills.map((s: { id: string; kind: string }) => [s.id, s.kind]),
    );
    expect(kinds.get("resume-analyzer")).toBe("builtin");
    expect(kinds.get("interviewer")).toBe("builtin");
    expect(kinds.get("target-only")).toBe("plugin");
    const target = body.skills.find(
      (s: { id: string }) => s.id === "target-only",
    );
    expect(target.compatible).toBe(true);
    expect(target.capabilities ?? []).toEqual([]);
    expect(
      body.pluginErrors.some((e: { dir: string }) => e.dir === "write-access"),
    ).toBe(true);
  });

  it("GET /api/plugins returns install views", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime });
    const body = await json(await app.request("/api/plugins"));
    const target = body.plugins.find(
      (p: { manifest: { id: string } }) => p.manifest.id === "target-only",
    );
    expect(target.enabled).toBe(true);
    expect(target.permissions.length).toBeGreaterThan(0);
  });

  it("PUT /api/plugins/:id toggles enablement; run → 409 when disabled", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime });
    const put = await app.request("/api/plugins/target-only", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(put.status).toBe(200);
    const res = await app.request("/api/plugins/target-only/run", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe("PLUGIN_DISABLED");
  });

  it("POST /api/plugins/:id/run executes the plugin", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(fixtureDir, orchestrator, logger);
    await setup(orchestrator);
    const app = createApp({ orchestrator, runtime });
    const res = await app.request("/api/plugins/target-only/run", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.output.keys).toEqual(["target"]);
    expect(body.output.runtimeError).toBe("PERMISSION_DENIED");
    expect(body.evidenceWritten).toBe(0);
    const missing = await app.request("/api/plugins/nope/run", { method: "POST" });
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });
});
