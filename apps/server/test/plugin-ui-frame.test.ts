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

function makeOrchestrator() {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orchestrator = new InterviewOrchestrator({ store, runtime, logger });
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

const PG = "postgres-interviewer";
const FRAME = `/api/plugins/${PG}/ui/frame?component=postgres-skill-tree`;

describe("GET /api/plugins/:id/ui/frame (v0.4 Level 2)", () => {
  it("returns a sandboxed document with strict CSP + security headers", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime });

    const res = await app.request(`http://test.local${FRAME}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");

    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain(
      "http://test.local/api/plugins/postgres-interviewer/ui/assets/",
    );
    expect(csp).toContain(
      "http://test.local/api/ui/runtime/plugin-runtime.js",
    );

    const nonce1 = /'nonce-([^']+)'/.exec(csp)![1];
    const res2 = await app.request(`http://test.local${FRAME}`);
    const nonce2 = /'nonce-([^']+)'/.exec(
      res2.headers.get("content-security-policy")!,
    )![1];
    expect(nonce1).not.toBe(nonce2);

    const html = await res.text();
    expect(html).toContain(`nonce="${nonce1}"`);
    expect(html).toContain('type="importmap"');
    expect(html).toContain('"@interview-os/ui"');
    expect(html).toContain('"react/jsx-runtime"');
    expect(html).toContain("plugin-runtime.css");
    expect(html).toContain(
      "/api/plugins/postgres-interviewer/ui/assets/index.js",
    );
    expect(html).toContain('"postgres-skill-tree"');
  });

  it("rejects unknown plugins, undeclared components, and disabled plugins", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime });

    expect(
      (await app.request("/api/plugins/nope/ui/frame?component=x")).status,
    ).toBe(404);
    // declared but declarative — not a frame
    expect(
      (
        await app.request(
          "/api/plugins/postgres-interviewer/ui/frame?component=readiness-card",
        )
      ).status,
    ).toBe(404);
    // nothing declared
    expect(
      (
        await app.request(
          "/api/plugins/postgres-interviewer/ui/frame?component=nope",
        )
      ).status,
    ).toBe(404);
    // missing both selectors
    expect(
      (await app.request("/api/plugins/postgres-interviewer/ui/frame")).status,
    ).toBe(400);

    await orchestrator.setPluginEnabled(PG, false);
    const res = await app.request(FRAME);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("PLUGIN_DISABLED");
  });
});

describe("GET /api/plugins/:id/ui/assets/* (v0.4 Level 2)", () => {
  it("serves a declared plugin's ui/ assets with nosniff + content type", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime });
    const res = await app.request(
      "/api/plugins/postgres-interviewer/ui/assets/index.js",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await res.text()).length).toBeGreaterThan(50);
  });

  it("rejects traversal — plain, encoded, absolute, wrong extension", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    const app = createApp({ orchestrator, runtime });
    const base = "/api/plugins/postgres-interviewer/ui/assets/";
    for (const p of [
      "..%2findex.ts", // encoded ../
      "%2e%2e%2findex.ts", // fully encoded ../
      "%2e%2e%2f%2e%2e%2fskill.yaml",
      "..%5cindex.ts", // encoded backslash traversal
      "%2fetc%2fpasswd", // absolute
      "nested%2f..%2f..%2fskill.yaml",
      "index.ts", // wrong extension
      "missing.js",
    ]) {
      const res = await app.request(base + p);
      expect([400, 404], p).toContain(res.status);
    }
  });

  it("rejects a symlink escaping ui/", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-frame-"));
    fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
    const outside = path.join(dir, "secret.js");
    fs.writeFileSync(outside, "export default {};\n");
    try {
      fs.symlinkSync(outside, path.join(dir, "ui", "escape.js"));
    } catch {
      return; // platform without symlink privilege — covered by realpath checks
    }
    const { orchestrator, runtime } = makeOrchestrator();
    const manifest = SkillManifestSchema.parse({
      id: "symlink-escape",
      version: "1.0.0",
      kind: "plugin",
      description: "fixture",
      inputs: [],
      permissions: [] as Permission[],
      capabilities: ["ui"],
      ui: {
        slots: {
          "dashboard.cards": [
            { component: "c", kind: "frame", entry: "ui/index.js" },
          ],
        },
      },
    });
    orchestrator.registerPlugin(manifest, { execute: () => ({}) }, { dir });
    const app = createApp({ orchestrator, runtime });
    const res = await app.request(
      "/api/plugins/symlink-escape/ui/assets/escape.js",
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/ui/runtime/* (v0.4 Level 2)", () => {
  it("serves the runtime bundle and 503s when it is not built", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    const app = createApp({ orchestrator, runtime });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-rt-"));
    process.env.INTERVIEW_OS_UI_RUNTIME_DIR = dir;
    try {
      const missing = await app.request("/api/ui/runtime/plugin-runtime.js");
      expect(missing.status).toBe(503);
      expect((await json(missing)).error.message).toMatch(/build:runtime/);

      fs.writeFileSync(path.join(dir, "plugin-runtime.js"), "// runtime\n");
      const ok = await app.request("/api/ui/runtime/plugin-runtime.js");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("text/javascript");

      expect((await app.request("/api/ui/runtime/evil.js")).status).toBe(404);
    } finally {
      delete process.env.INTERVIEW_OS_UI_RUNTIME_DIR;
    }
  });
});

describe("POST /api/plugins/:id/ui/data + /ui/run (v0.4 Level 2)", () => {
  it("returns only declared AND granted slices", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    await setup(orchestrator);
    const app = createApp({ orchestrator, runtime });
    const data = (body: unknown) =>
      app.request(`/api/plugins/${PG}/ui/data`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // all declared permissions granted → all declared input slices present
    await orchestrator.setPluginEnabled(PG, true, [
      "candidate.read",
      "target.read",
      "readiness.read",
      "taxonomy.read",
    ]);
    const full = await json(await data({ component: "postgres-skill-tree" }));
    expect(full.slices.readiness).toBeTruthy();
    expect(full.slices.candidate).toBeTruthy();
    expect(full.slices.target).toBeTruthy();

    // revoke readiness.read → the readiness slice is gone
    await orchestrator.setPluginEnabled(PG, true, [
      "candidate.read",
      "target.read",
      "taxonomy.read",
    ]);
    const revoked = await json(await data({ component: "postgres-skill-tree" }));
    expect(revoked.slices.readiness).toBeUndefined();
    expect(revoked.slices.gaps).toBeUndefined();
    expect(revoked.slices.candidate).toBeTruthy();

    // a declarative component is not a frame → 404
    expect((await data({ component: "readiness-card" })).status).toBe(404);
    // missing selector → 400
    expect((await data({})).status).toBe(400);
  });

  it("runs the plugin for a declared frame and gates undeclared/disabled", async () => {
    const { orchestrator, runtime } = makeOrchestrator();
    await loadPlugins(pluginsDir, orchestrator, logger);
    await setup(orchestrator);
    const app = createApp({ orchestrator, runtime });
    const run = (body: unknown) =>
      app.request(`/api/plugins/${PG}/ui/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const res = await run({
      component: "postgres-skill-tree",
      request: { skillId: "sql.indexing" },
    });
    expect(res.status).toBe(200);
    const { output } = await json(res);
    expect(Array.isArray(output.questions)).toBe(true);
    expect(output.questions.length).toBeGreaterThan(0);

    expect((await run({ component: "nope" })).status).toBe(404);
    expect((await run({ component: "readiness-card" })).status).toBe(404);
    expect((await run({})).status).toBe(400);

    await orchestrator.setPluginEnabled(PG, false);
    const disabled = await run({ component: "postgres-skill-tree" });
    expect(disabled.status).toBe(409);
  });
});
