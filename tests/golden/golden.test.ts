/**
 * Keeps the committed golden fixtures in sync with packages/core: regenerates
 * every area file in memory and asserts byte equality with what is on disk.
 * Fails if a committed area file is missing.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GOLDEN_DIR, buildFiles } from "./generate.js";

const files = buildFiles();

describe("golden fixtures match packages/core", () => {
  for (const [name, content] of Object.entries(files)) {
    it(`${name} is up to date`, () => {
      const file = path.join(GOLDEN_DIR, name);
      expect(
        fs.existsSync(file),
        `${name} is missing — run \`node --import tsx tests/golden/generate.ts\``,
      ).toBe(true);
      expect(
        fs.readFileSync(file, "utf8"),
        `${name} is stale — run \`node --import tsx tests/golden/generate.ts\``,
      ).toBe(content);
    });
  }
});
