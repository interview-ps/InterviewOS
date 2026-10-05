import { describe, expect, it } from "vitest";
import { validateUITree, UINodeSchema } from "@interview-os/frontend-types";

const text = (t: string) => ({ type: "text", text: t });

describe("validateUITree", () => {
  it("accepts a normal tree", () => {
    const tree = validateUITree(
      {
        type: "card",
        title: "Hello",
        children: [
          { type: "stat", label: "Score", value: "72%", trend: "up" },
          { type: "button", label: "Go", action: { type: "navigate", to: "/skills" } },
        ],
      },
      { pluginId: "pg" },
    );
    expect(tree.type).toBe("card");
  });

  it("rejects depth > 8", () => {
    let node: unknown = text("leaf");
    for (let i = 0; i < 9; i++) node = { type: "stack", children: [node] };
    expect(() => validateUITree(node)).toThrow(/depth/);
  });

  it("rejects > 300 nodes", () => {
    const node = { type: "stack", children: Array.from({ length: 301 }, () => text("x")) };
    expect(() => validateUITree(node)).toThrow(/300 nodes/);
  });

  it("rejects > 8 tabs", () => {
    const node = {
      type: "tabs",
      tabs: Array.from({ length: 9 }, (_, i) => ({ label: `t${i}`, children: [text("x")] })),
    };
    expect(() => validateUITree(node)).toThrow();
  });

  it("rejects strings > 500 chars", () => {
    expect(() => validateUITree(text("x".repeat(501)))).toThrow();
  });

  it("rejects > 64 KB serialized", () => {
    const node = {
      type: "stack",
      children: Array.from({ length: 200 }, () => text("x".repeat(490))),
    };
    expect(() => validateUITree(node)).toThrow(/64|bytes/i);
  });
});

describe("UIAction validation", () => {
  const btn = (action: unknown) => ({ type: "button", label: "go", action });

  it("allows app allowlisted routes", () => {
    expect(() =>
      validateUITree(btn({ type: "navigate", to: "/readiness" }), { pluginId: "pg" }),
    ).not.toThrow();
  });

  it("rejects unknown routes", () => {
    expect(() =>
      validateUITree(btn({ type: "navigate", to: "/admin" }), { pluginId: "pg" }),
    ).toThrow(/allowlisted/);
  });

  it("allows paths under the same plugin only", () => {
    const good = btn({ type: "navigate", to: "/plugins/pg/stats" });
    expect(() => validateUITree(good, { pluginId: "pg" })).not.toThrow();
    const bad = btn({ type: "navigate", to: "/plugins/other/stats" });
    expect(() => validateUITree(bad, { pluginId: "pg" })).toThrow(/allowlisted/);
  });

  it("allows the plugin's own page root", () => {
    const good = btn({ type: "navigate", to: "/plugins/pg" });
    expect(() => validateUITree(good, { pluginId: "pg" })).not.toThrow();
  });

  it.each([
    ["traversal", "/plugins/pg/../other"],
    ["encoded traversal", "/plugins/pg/%2e%2e/other"],
    ["encoded slash", "/plugins/pg%2fother"],
    ["backslash", "/plugins/pg\\x"],
    ["double slash", "/plugins//pg/x"],
    ["query smuggle", "/skills?next=https://evil.example"],
    ["fragment smuggle", "/skills#x"],
    ["control char", "/plugins/pg/x\n"],
  ])("rejects navigate %s", (_label, to) => {
    expect(() =>
      validateUITree(btn({ type: "navigate", to }), { pluginId: "pg" }),
    ).toThrow();
  });

  it.each([
    ["traversal", "/../x"],
    ["encoded traversal", "/%2E%2E/x"],
    ["backslash", "/x\\y"],
    ["double slash", "//x"],
    ["query", "/x?y=1"],
    ["fragment", "/x#y"],
    ["control char", "/x\x07"],
  ])("rejects openPluginPage %s", (_label, path) => {
    const action = { type: "openPluginPage", path };
    expect(() =>
      validateUITree(btn(action), { pluginId: "pg" }),
    ).toThrow();
  });

  it("accepts a clean openPluginPage path", () => {
    const action = { type: "openPluginPage", path: "/stats" };
    expect(() =>
      validateUITree(btn(action), { pluginId: "pg" }),
    ).not.toThrow();
  });

  it("rejects runPlugin requests over 2 KB", () => {
    const action = { type: "runPlugin", request: { blob: "x".repeat(2100) } };
    expect(() => validateUITree(btn(action), { pluginId: "pg" })).toThrow(/2|KB|bytes/i);
  });

  it("rejects url/html-bearing node shapes entirely", () => {
    expect(
      UINodeSchema.safeParse({ type: "text", text: "hi", url: "https://evil.example" }).success,
    ).toBe(false);
    expect(
      UINodeSchema.safeParse({ type: "text", text: "hi", html: "<b>x</b>" }).success,
    ).toBe(false);
    expect(
      UINodeSchema.safeParse({ type: "link", href: "https://x" }).success,
    ).toBe(false);
  });
});
