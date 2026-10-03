import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { RuntimeManager } from "../src/manager.js";
import type {
  AIRuntime,
  RuntimeKind,
  RuntimeStatus,
} from "../src/interface/index.js";
import { MockRuntime } from "../src/mock/MockRuntime.js";

const disposed = new Set<AIRuntime>();
const created: RuntimeKind[] = [];

/** A MockRuntime posing as another provider (kind + healthCheck swapped). */
function fakeRuntime(
  kind: RuntimeKind,
  opts: { available?: boolean; version?: string } = {},
): AIRuntime {
  const rt = new MockRuntime() as AIRuntime & { kind: RuntimeKind };
  rt.kind = kind;
  rt.healthCheck = async (): Promise<RuntimeStatus> => ({
    runtime: kind,
    available: opts.available ?? true,
    version: opts.version,
    status: (opts.available ?? true) ? "ready" : "unavailable",
  });
  rt.dispose = async () => {
    disposed.add(rt);
  };
  return rt;
}

function makeManager(
  opts: Parameters<typeof RuntimeManager.create>[0] & { available?: boolean },
): Promise<RuntimeManager> {
  const { available, ...rest } = opts;
  return RuntimeManager.create({
    factory: (kind) => {
      created.push(kind);
      return fakeRuntime(kind, available === false ? { available: false } : {});
    },
    ...rest,
  });
}

function reset() {
  disposed.clear();
  created.length = 0;
}

describe("RuntimeManager.create", () => {
  it("uses INTERVIEW_OS_RUNTIME over the persisted preference", async () => {
    reset();
    const mgr = await makeManager({
      env: { INTERVIEW_OS_RUNTIME: "mock" },
      preferredKind: "devin",
    });
    expect(mgr.kind).toBe("mock");
  });

  it("uses preferredKind when the env var is unset", async () => {
    reset();
    const mgr = await makeManager({ env: {}, preferredKind: "devin" });
    expect(mgr.kind).toBe("devin");
  });

  it("defaults to codex and ignores a bogus persisted kind", async () => {
    reset();
    const mgr = await makeManager({ env: {}, preferredKind: "not-a-thing" });
    expect(mgr.kind).toBe("codex");
  });

  it("falls back to mock when INTERVIEW_OS_RUNTIME_FALLBACK=mock", async () => {
    reset();
    const mgr = await makeManager({
      env: { INTERVIEW_OS_RUNTIME: "devin", INTERVIEW_OS_RUNTIME_FALLBACK: "mock" },
      available: false,
    });
    expect(mgr.kind).toBe("mock");
    // the unavailable devin delegate was disposed during fallback
    expect(disposed.size).toBe(1);
  });

  it("fires onSwitch for the initial runtime", async () => {
    reset();
    const seen: RuntimeKind[] = [];
    await makeManager({
      env: { INTERVIEW_OS_RUNTIME: "mock" },
      onSwitch: (rt) => seen.push(rt.kind),
    });
    expect(seen).toEqual(["mock"]);
  });
});

describe("RuntimeManager.switchTo", () => {
  it("swaps the delegate, fires onSwitch, and disposes the previous runtime", async () => {
    reset();
    const seen: RuntimeKind[] = [];
    const mgr = await makeManager({
      env: { INTERVIEW_OS_RUNTIME: "mock" },
      onSwitch: (rt) => seen.push(rt.kind),
    });
    const prev = (await mgr.healthCheck()).runtime;
    const status = await mgr.switchTo("devin");
    expect(mgr.kind).toBe("devin");
    expect(status.runtime).toBe("devin");
    expect(status.available).toBe(true);
    expect(seen).toEqual(["mock", "devin"]);
    expect(disposed.size).toBe(1);
    expect(prev).toBe("mock");
  });

  it("keeps the selection even when the new provider is unavailable", async () => {
    reset();
    const mgr = await RuntimeManager.create({
      env: { INTERVIEW_OS_RUNTIME: "mock" },
      factory: (kind) => fakeRuntime(kind, { available: kind !== "codex" }),
    });
    const status = await mgr.switchTo("codex");
    expect(mgr.kind).toBe("codex");
    expect(status.available).toBe(false);
  });

  it("delegates calls to the current provider", async () => {
    reset();
    const mgr = await makeManager({ env: { INTERVIEW_OS_RUNTIME: "mock" } });
    const res = await mgr.runTask({
      taskId: "x",
      instructions: "x",
      input: {},
      outputSchema: {},
    });
    // MockRuntime has no registered handlers → PROTOCOL error, proving delegation
    expect(res.ok).toBe(false);
    await mgr.switchTo("claude");
    const models = await mgr.listModels();
    expect(models.map((m) => m.id)).toEqual(["mock"]); // fake claude is a MockRuntime
  });
});

describe("RuntimeManager.probeAll", () => {
  it("returns one status per runtime kind from the checkers", async () => {
    reset();
    const mgr = await RuntimeManager.create({
      env: { INTERVIEW_OS_RUNTIME: "mock" },
      factory: (kind) => fakeRuntime(kind),
      healthCheckers: {
        codex: async () => ({
          runtime: "codex",
          available: false,
          status: "unavailable",
          message: "not installed",
        }),
        devin: async () => ({
          runtime: "devin",
          available: true,
          version: "2026.8.18",
          status: "ready",
        }),
        claude: async () => {
          throw new Error("spawn exploded");
        },
      },
    });
    const probes = await mgr.probeAll();
    expect(probes).toHaveLength(5);
    const byKind = Object.fromEntries(probes.map((p) => [p.runtime, p]));
    expect(byKind.codex?.available).toBe(false);
    expect(byKind.devin?.version).toBe("2026.8.18");
    expect(byKind.claude?.status).toBe("error"); // thrown checker → error status
    expect(byKind.mock?.available).toBe(true);   // falls back to built-in checker
    expect(byKind.opencode?.available).toBeDefined();
  });
});

describe("createRuntime", () => {
  it("returns a RuntimeManager honouring the env selection", async () => {
    reset();
    const rt = await createRuntime({
      env: { INTERVIEW_OS_RUNTIME: "mock" },
      factory: (kind) => fakeRuntime(kind),
    });
    expect(rt).toBeInstanceOf(RuntimeManager);
    expect(rt.kind).toBe("mock");
  });
});
