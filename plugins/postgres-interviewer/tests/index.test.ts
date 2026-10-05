import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runPluginWithMock } from "@interview-os/plugin-sdk/testing";
import { loadManifestFile } from "@interview-os/plugin-sdk";
import { validateUITree } from "@interview-os/core";
import plugin from "../index.js";

const manifest = await loadManifestFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

describe("postgres-interviewer", () => {
  it("returns the full question bank", async () => {
    const { output } = await runPluginWithMock({ plugin, manifest });
    const { questions } = output as { questions: { skillId: string }[] };
    expect(questions.length).toBeGreaterThanOrEqual(10);
  });

  it("filters questions by request.skillId", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      request: { skillId: "sql.indexing" },
    });
    const { questions } = output as { questions: { skillId: string }[] };
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.every((q) => q.skillId === "sql.indexing")).toBe(true);
  });

  it("emits evidence proposals from a self-check", async () => {
    const { evidenceProposals } = await runPluginWithMock({
      plugin,
      manifest,
      request: {
        selfCheck: [
          { skillId: "sql.indexing", passed: true },
          { skillId: "sql.transactions", passed: false },
        ],
      },
    });
    expect(evidenceProposals).toHaveLength(2);
    expect(evidenceProposals[0].score).toBe(0.7);
    expect(evidenceProposals[1].score).toBe(0.3);
    expect(evidenceProposals[0].confidence).toBe(0.4);
  });

  const readinessSlice = {
    "sql.indexing": { label: "SQL Indexing", score: 0.5, confidence: 0.7 },
    "sql.transactions": { label: "SQL Transactions", score: 0.9, confidence: 0.8 },
  };

  it.each(["readiness-card", "explain-analyze", "home"])(
    "renders a valid declarative tree for %s",
    async (component) => {
      const { output } = await runPluginWithMock({
        plugin,
        manifest,
        request: { kind: "ui", component },
        slices: { readiness: readinessSlice, gaps: [] },
      });
      const tree = validateUITree((output as { ui?: unknown }).ui, {
        pluginId: manifest.id,
      });
      expect(tree.type).toBeTruthy();
    },
  );

  it("dashboard card shows the mean SQL score as a percent", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      request: { kind: "ui", component: "readiness-card" },
      slices: { readiness: readinessSlice },
    });
    const tree = validateUITree((output as { ui?: unknown }).ui, {
      pluginId: manifest.id,
    });
    const stat = (tree as { children: { type: string; value?: string }[] }).children.find(
      (c) => c.type === "stat",
    );
    expect(stat?.value).toBe("70%");
  });

  it("home page renders tabs with skill scores and weaknesses", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      request: { kind: "ui", component: "home" },
      slices: {
        readiness: readinessSlice,
        gaps: [{ skillId: "sql.indexing", label: "SQL Indexing", severity: "high", gap: 0.5 }],
      },
    });
    const tree = validateUITree((output as { ui?: unknown }).ui, {
      pluginId: manifest.id,
    }) as { children: { type: string; tabs?: { label: string }[] }[] };
    const tabs = tree.children.find((c) => c.type === "tabs");
    expect(tabs?.tabs?.map((t) => t.label)).toEqual([
      "Queries",
      "Indexes",
      "Transactions",
      "Locking",
    ]);
    const weaknesses = tree.children.find(
      (c) => c.type === "card" && (c as { title?: string }).title === "Recent weaknesses",
    );
    expect(weaknesses).toBeTruthy();
  });
});
