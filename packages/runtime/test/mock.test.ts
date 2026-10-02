import { describe, expect, it } from "vitest";
import { MockRuntime, type RuntimeEvent } from "../src/index.js";

describe("MockRuntime", () => {
  it("dispatches runTask to a registered handler", async () => {
    const rt = new MockRuntime();
    rt.register("echo", (input) => ({ echoed: input }));
    const result = await rt.runTask({
      taskId: "echo",
      instructions: "echo the input",
      input: { hello: "world" },
      outputSchema: { type: "object" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual({ echoed: { hello: "world" } });
      expect(result.raw).toBe(JSON.stringify({ echoed: { hello: "world" } }));
    }
  });

  it("returns PROTOCOL error for an unknown taskId", async () => {
    const rt = new MockRuntime();
    const result = await rt.runTask({
      taskId: "nope",
      instructions: "",
      input: {},
      outputSchema: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROTOCOL");
      expect(result.error.message).toContain("nope");
    }
  });

  it("supports sessions with streaming events", async () => {
    const rt = new MockRuntime();
    rt.register("chat", (input) => ({ reply: `turn:${JSON.stringify(input)}` }));
    const session = await rt.createSession({});
    expect(session.threadId).toMatch(/^mock-thread-/);

    const events: RuntimeEvent[] = [];
    for await (const e of rt.sendMessage(session.id, { text: "hi", taskId: "chat", input: 1 })) {
      events.push(e);
    }
    expect(events[0]).toEqual({ type: "started" });
    expect(events.some((e) => e.type === "delta")).toBe(true);
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    if (completed?.type === "completed") {
      expect(completed.output).toEqual({ reply: "turn:1" });
    }
  });

  it("resumes sessions by threadId", async () => {
    const rt = new MockRuntime();
    const s1 = await rt.createSession({});
    const s2 = await rt.resumeSession(s1.threadId, {});
    expect(s2.id).toBe(s1.id);
    const s3 = await rt.resumeSession("never-seen", {});
    expect(s3.threadId).toBe("never-seen");
  });

  it("errors for unknown sessions", async () => {
    const rt = new MockRuntime();
    const events: RuntimeEvent[] = [];
    for await (const e of rt.sendMessage("ghost", { text: "x" })) events.push(e);
    expect(events[0]?.type).toBe("error");
  });
});
