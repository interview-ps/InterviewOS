import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * v1 boundary guarantee: core code must stay plugin-agnostic. No file under
 * apps/server/src, apps/web/src or packages/core/src may reference a specific
 * bundled plugin/pack id — extension points are contract-driven only.
 */
const REPO = path.resolve(__dirname, "../..");
const SCANNED = [
  "apps/server/src",
  "apps/web/src",
  "packages/core/src",
];
const FORBIDDEN = [
  "postgres-interviewer",
  "interview-day-checklist",
  "learning-resources",
  "frame-escape",
  "fixture-runtime",
];

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) yield p;
  }
}

describe("plugin boundary", () => {
  it("no core file references a bundled plugin/pack id", () => {
    const offenders: string[] = [];
    for (const root of SCANNED) {
      const abs = path.join(REPO, root);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        const text = fs.readFileSync(file, "utf8");
        for (const id of FORBIDDEN) {
          if (text.includes(id)) {
            offenders.push(`${path.relative(REPO, file)} → "${id}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
