import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SkillManifestSchema } from "@interview-os/core";

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "skill.schema.json",
);
const schema = z.toJSONSchema(SkillManifestSchema, {
  unrepresentable: "any",
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${out}`);
