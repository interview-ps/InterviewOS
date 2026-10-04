import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "../src/orchestrator/index.js";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { createApp } from "../src/http/app.js";

function makeWebDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-web-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log('spa');\n");
  return dir;
}

function makeServer(webDir?: string) {
  const logger = createLogger({ level: "error", sink: () => {} });
  const runtime = new MockRuntime();
  const store = openStore(":memory:");
  const orchestrator = new InterviewOrchestrator({ store, runtime, logger });
  return createApp({ orchestrator, runtime, webDir });
}

describe("static SPA serving", () => {
  it("serves index.html at / with an html content-type", async () => {
    const app = makeServer(makeWebDir());
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('<div id="root">');
  });

  it("serves built assets from the web dir", async () => {
    const app = makeServer(makeWebDir());
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("console.log('spa')");
  });

  it("falls back to index.html for client-side routes", async () => {
    const app = makeServer(makeWebDir());
    for (const p of ["/interview/abc", "/prep"]) {
      const res = await app.request(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  it("keeps the API 404 for unknown /api paths", async () => {
    const app = makeServer(makeWebDir());
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("returns 404 for / when no webDir is configured", async () => {
    const app = makeServer();
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });
});
