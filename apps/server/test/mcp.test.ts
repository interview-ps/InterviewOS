import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, McpManager, openStore } from "../src/orchestrator/index.js";
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

const FIXTURE = path.join(REPO_ROOT, "tests/fixtures/fake-mcp-server.mjs");
const logger = createLogger({ level: "error", sink: () => {} });

function configPath(servers: unknown[] | "INVALID" | "MISSING"): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ios-mcp-")), "mcp.json");
  if (servers === "MISSING") return file;
  fs.writeFileSync(
    file,
    servers === "INVALID" ? "{ not json" : JSON.stringify({ servers }),
  );
  return file;
}

const fakeServer = (over: Record<string, unknown> = {}) => ({
  id: "fake",
  name: "Fake MCP",
  command: process.execPath,
  args: [FIXTURE],
  envPassthrough: ["TEST_PASSTHROUGH_VAR"],
  ...over,
});

function makeOrchestrator(cfg: string) {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const mcp = new McpManager(cfg, logger, async (id) => {
    const row = await store.getMcpServer(id);
    return {
      enabled: (row?.enabled ?? 0) === 1,
      allowedTools: (row?.allowedTools as string[] | undefined) ?? [],
    };
  });
  const orchestrator = new InterviewOrchestrator({ store, runtime, logger, mcp });
  return { orchestrator, mcp };
}

describe("MCP (v0.4)", () => {
  it("missing config file → no servers, no error", async () => {
    const { orchestrator } = makeOrchestrator(configPath("MISSING"));
    const view = await orchestrator.listMcpServers();
    expect(view.servers).toEqual([]);
    expect(view.loadError).toBeNull();
  });

  it("invalid config file → surfaced loadError, never a crash", async () => {
    const { orchestrator } = makeOrchestrator(configPath("INVALID"));
    const view = await orchestrator.listMcpServers();
    expect(view.servers).toEqual([]);
    expect(view.loadError).toMatch(/invalid MCP config/);
  });

  it("disabled server rejects tool calls", async () => {
    const { orchestrator, mcp } = makeOrchestrator(configPath([fakeServer()]));
    await expect(
      orchestrator.fetchExternalContext({ serverId: "fake", tool: "get_repository" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await mcp.closeAll();
  });

  it("a tool not in allowedTools is rejected", async () => {
    const { orchestrator, mcp } = makeOrchestrator(configPath([fakeServer()]));
    await orchestrator.updateMcpServer("fake", {
      enabled: true,
      allowedTools: ["echo_env"],
    });
    await expect(
      orchestrator.fetchExternalContext({
        serverId: "fake",
        tool: "get_repository",
        args: { repo: "x/y" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("allowedTools") });
    await mcp.closeAll();
  });

  it("allowed call stores a context; oversized output is truncated", async () => {
    const { orchestrator, mcp } = makeOrchestrator(configPath([fakeServer()]));
    await orchestrator.updateMcpServer("fake", {
      enabled: true,
      allowedTools: ["get_repository", "big_output"],
    });
    const ctx = await orchestrator.fetchExternalContext({
      serverId: "fake",
      tool: "get_repository",
      args: { repo: "acme/widgets" },
    });
    expect(ctx.text).toContain("acme/widgets");
    expect(ctx.serverId).toBe("fake");
    const big = await orchestrator.fetchExternalContext({
      serverId: "fake",
      tool: "big_output",
    });
    expect(big.text.length).toBe(12_000);
    expect((await orchestrator.listExternalContexts()).length).toBe(2);
    await orchestrator.deleteExternalContext(ctx.id);
    expect((await orchestrator.listExternalContexts()).length).toBe(1);
    await mcp.closeAll();
  });

  it("child env carries only basics + passthrough names — app secrets stay out", async () => {
    process.env.TEST_PASSTHROUGH_VAR = "present";
    process.env.INTERVIEW_OS_DUMMY_SECRET = "should-not-leak";
    try {
      const { orchestrator, mcp } = makeOrchestrator(configPath([fakeServer()]));
      await orchestrator.updateMcpServer("fake", {
        enabled: true,
        allowedTools: ["echo_env"],
      });
      const ctx = await orchestrator.fetchExternalContext({
        serverId: "fake",
        tool: "echo_env",
      });
      const names = JSON.parse(ctx.text) as string[];
      expect(names).toContain("TEST_PASSTHROUGH_VAR");
      expect(names).not.toContain("INTERVIEW_OS_DUMMY_SECRET");
      await mcp.closeAll();
    } finally {
      delete process.env.TEST_PASSTHROUGH_VAR;
      delete process.env.INTERVIEW_OS_DUMMY_SECRET;
    }
  });

  it("an unreachable server fails cleanly, never crashes", async () => {
    const { orchestrator, mcp } = makeOrchestrator(
      configPath([fakeServer({ command: "definitely-not-a-real-binary-xyz" })]),
    );
    await orchestrator.updateMcpServer("fake", { enabled: true });
    await expect(orchestrator.listMcpTools("fake")).rejects.toMatchObject({
      code: "MCP_UNAVAILABLE",
    });
    await mcp.closeAll();
  });

  it("startInterview(contextId) grounds the question on the context", async () => {
    const { orchestrator, mcp } = makeOrchestrator(configPath([fakeServer()]));
    await orchestrator.updateMcpServer("fake", {
      enabled: true,
      allowedTools: ["get_repository"],
    });
    const ctx = await orchestrator.fetchExternalContext({
      serverId: "fake",
      tool: "get_repository",
      args: { repo: "acme/widgets" },
      title: "acme/widgets repo",
    });
    await orchestrator.setupWorkspace({
      resumeText,
      jobDescription,
      company: example.company,
      role: example.role,
      level: example.level,
    });
    const { session, question } = await orchestrator.startInterview({
      plannedQuestions: 1,
      contextId: ctx.id,
    });
    expect(session!.contextId).toBe(ctx.id);
    expect(question!.text).toContain("acme/widgets repo");
    await mcp.closeAll();
  });

  it("unknown contextId → NOT_FOUND", async () => {
    const { orchestrator } = makeOrchestrator(configPath([fakeServer()]));
    await orchestrator.setupWorkspace({
      resumeText,
      jobDescription,
      company: example.company,
      role: example.role,
      level: example.level,
    });
    await expect(
      orchestrator.startInterview({ contextId: "ctx_missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
