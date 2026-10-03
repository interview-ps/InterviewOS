import { describe, expect, it } from "vitest";
import { createLogger, newId, redact, textMeta } from "../../src/shared/index.js";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => lines.push(l), service: "test" });
  return { lines, logger };
}

describe("createLogger", () => {
  it("emits JSON lines with ts, level, event and base fields", () => {
    const { lines, logger } = capture();
    logger.info("workflow.started", { workflowId: "w1" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("workflow.started");
    expect(parsed.service).toBe("test");
    expect(parsed.workflowId).toBe("w1");
    expect(typeof parsed.ts).toBe("string");
  });

  it("respects the minimum level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (l) => lines.push(l) });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["c", "d"]);
  });

  it("redacts sensitive keys recursively", () => {
    const { lines, logger } = capture();
    logger.info("evt", {
      apiKey: "abc",
      nested: { password: "hunter2", list: [{ authorization: "Bearer x" }] },
      safe: "visible",
    });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.apiKey).toBe("[REDACTED]");
    expect(parsed.nested.password).toBe("[REDACTED]");
    expect(parsed.nested.list[0].authorization).toBe("[REDACTED]");
    expect(parsed.safe).toBe("visible");
    expect(lines[0]).not.toContain("hunter2");
    expect(lines[0]).not.toContain("Bearer x");
  });

  it("redacts keys in base fields and child loggers", () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (l) => lines.push(l),
      sessionCookie: "jar",
    });
    logger.child({ authToken: "t" }).info("evt", { ok: 1 });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.sessionCookie).toBe("[REDACTED]");
    expect(parsed.authToken).toBe("[REDACTED]");
    expect(parsed.ok).toBe(1);
  });

  it("handles circular structures without crashing", () => {
    const { lines, logger } = capture();
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    logger.info("evt", { obj });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).obj.self).toBe("[Circular]");
  });
});

describe("redact", () => {
  it("matches key names case-insensitively and by substring", () => {
    const out = redact({
      SECRET: 1,
      "x-access-token": 2,
      cookieJar: 3,
      monKEY: 4,
      plain: 5,
    });
    expect(out).toEqual({
      SECRET: "[REDACTED]",
      "x-access-token": "[REDACTED]",
      cookieJar: "[REDACTED]",
      monKEY: "[REDACTED]",
      plain: 5,
    });
  });
});

describe("newId", () => {
  it("prefixes a uuid", () => {
    const id = newId("sess");
    expect(id).toMatch(/^sess_[0-9a-f-]{36}$/);
    expect(newId("x")).not.toBe(newId("x"));
  });
});

describe("textMeta", () => {
  it("returns only the length", () => {
    expect(textMeta("hello world")).toEqual({ length: 11 });
  });
});
