import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillManifestSchema } from "@interview-os/core";

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "skill.schema.json",
);

describe("skill.schema.json", () => {
  it("is up to date with SkillManifestSchema (run scripts/gen-schema.ts)", () => {
    const expected =
      JSON.stringify(
        z.toJSONSchema(SkillManifestSchema, { unrepresentable: "any" }),
        null,
        2,
      ) + "\n";
    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(fs.readFileSync(schemaPath, "utf8")).toBe(expected);
  });
});
