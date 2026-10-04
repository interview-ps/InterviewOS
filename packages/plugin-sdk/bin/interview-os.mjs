#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const KNOWN_INPUTS = {
  candidate: "candidate.read",
  target: "target.read",
  readiness: "readiness.read",
  gaps: "readiness.read",
  stories: "stories.read",
  recentEvaluations: "interview.read",
  resume: "resume.read",
  request: "taxonomy.read",
};
const KNOWN_PERMISSIONS = new Set([
  "candidate.read",
  "candidate.write",
  "target.read",
  "target.write",
  "readiness.read",
  "evidence.write",
  "interview.read",
  "interview.write",
  "stories.read",
  "stories.write",
  "resume.read",
  "resume.write",
  "preparation.write",
  "taxonomy.read",
  "runtime.invoke",
]);
const PLUGIN_WRITABLE = new Set(["evidence.write"]);
const ENTRY_FILES = ["index.ts", "index.js", "index.mjs"];

function fail(msg) {
  console.error(`interview-os: ${msg}`);
  process.exit(1);
}

function loadManifest(dir) {
  let raw;
  const yamlPath = path.join(dir, "skill.yaml");
  const jsonPath = path.join(dir, "manifest.json");
  if (fs.existsSync(yamlPath)) {
    raw = YAML.parse(fs.readFileSync(yamlPath, "utf8"));
  } else if (fs.existsSync(jsonPath)) {
    raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } else {
    fail(`no skill.yaml or manifest.json in ${dir}`);
  }
  if (typeof raw !== "object" || raw === null) fail("manifest must be an object");
  const m = { kind: "plugin", ...raw };
  if (typeof m.id !== "string" || !m.id) fail("manifest.id missing");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version)) {
    fail(`manifest.version "${m.version}" is not semver x.y.z`);
  }
  m.permissions = Array.isArray(m.permissions) ? m.permissions : [];
  for (const p of m.permissions) {
    if (!KNOWN_PERMISSIONS.has(p)) fail(`unknown permission "${p}"`);
    if (p.endsWith(".write") && !PLUGIN_WRITABLE.has(p)) {
      fail(`plugins may not request "${p}"`);
    }
  }
  m.inputs = (Array.isArray(m.inputs) ? m.inputs : []).map((i) => {
    if (typeof i === "string") {
      if (!(i in KNOWN_INPUTS)) fail(`unknown input key "${i}"`);
      return { key: i, permission: KNOWN_INPUTS[i] };
    }
    return i;
  });
  return m;
}

function validateDir(dir) {
  const manifest = loadManifest(dir);
  const entry = ENTRY_FILES.find((f) => fs.existsSync(path.join(dir, f)));
  if (!entry) fail(`plugin "${manifest.id}" has no index.ts/index.js entry`);
  const source = fs.readFileSync(path.join(dir, entry), "utf8");
  const idMatch = /\bid\s*:\s*["'`]([a-z][a-z0-9-]{0,79})["'`]/.exec(source);
  if (idMatch && idMatch[1] !== manifest.id) {
    fail(`entry id "${idMatch[1]}" does not match manifest id "${manifest.id}"`);
  }
  const permsMatch = /\bpermissions\s*:\s*\[([^\]]*)\]/s.exec(source);
  if (permsMatch) {
    for (const [, perm] of permsMatch[1].matchAll(/["'`]([a-z]+\.[a-z_]+)["'`]/g)) {
      if (!KNOWN_PERMISSIONS.has(perm)) continue;
      if (!manifest.permissions.includes(perm)) {
        fail(`entry requests "${perm}" which is not in the manifest permissions`);
      }
    }
  }
  console.log(`ok: ${manifest.id}@${manifest.version} (${entry})`);
}

const TEMPLATES = {
  "skill.yaml": (name) => `id: ${name}
name: ${name
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")}
version: 0.1.0
description: Describe what this skill does.
author: ""
permissions:
  - candidate.read
  - target.read
  - readiness.read
capabilities:
  - interview
inputs:
  - candidate
  - target
  - readiness
engines:
  interview-os: ">=0.4.0"
`,
  "index.ts": (name) => `import { defineSkill } from "@interview-os/plugin-sdk";

export default defineSkill({
  id: "${name}",
  permissions: ["candidate.read", "target.read", "readiness.read"],
  capabilities: ["interview"],
  inputs: ["candidate", "target", "readiness"],
  execute({ input, log }) {
    const target = input.target as { company?: string; role?: string } | undefined;
    const readiness = (input.readiness ?? {}) as Record<
      string,
      { score: number | null; label?: string }
    >;
    const weak = Object.values(readiness)
      .filter((d) => d.score !== null && d.score < 0.5)
      .map((d) => d.label ?? "unknown area");

    log("built checklist from readiness graph");
    return {
      title: target ? \`\${target.role} @ \${target.company}\` : "${name}",
      checklist: [
        ...weak.slice(0, 3).map((w) => \`Review \${w}\`),
        "Rehearse one STAR story out loud",
      ],
    };
  },
});
`,
  "tests/index.test.ts": (name) => `import { describe, expect, it } from "vitest";
import { runPluginWithMock } from "@interview-os/plugin-sdk/testing";
import plugin from "../index.js";

const manifest = {
  id: "${name}",
  version: "0.1.0",
  kind: "plugin" as const,
  description: "",
  name: "${name}",
  author: "",
  capabilities: ["interview" as const],
  outputs: [],
  permissions: ["candidate.read", "target.read", "readiness.read"] as const,
  inputs: [
    { key: "candidate", permission: "candidate.read" },
    { key: "target", permission: "target.read" },
    { key: "readiness", permission: "readiness.read" },
  ],
};

describe("${name}", () => {
  it("returns a checklist", async () => {
    const { output, logs } = await runPluginWithMock({
      plugin,
      manifest: manifest as never,
      slices: {
        target: { company: "Acme", role: "Engineer" },
        readiness: { "coding.algorithms": { score: 0.4, label: "Algorithms" } },
      },
    });
    expect((output as { checklist: string[] }).checklist.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
  });
});
`,
  "README.md": (name) => `# ${name}

An [Interview OS](https://github.com/) plugin skill.

- \`skill.yaml\` — manifest (permissions, inputs, engines)
- \`index.ts\` — \`defineSkill\` implementation
- \`tests/index.test.ts\` — vitest via \`runPluginWithMock\`

Validate with \`interview-os validate .\`
`,
};

const UI_MANIFEST_BLOCK = `capabilities:
  - ui
ui:
  slots:
    readiness.panels:
      - component: overview
        kind: frame
        entry: ui/index.js
        title: "Plugin overview"
`;

const UI_ENTRY = `import { useEffect, useState } from "react";
import { Card, CardTitle, SkillScore } from "@interview-os/ui";
import type { PluginFrameModule, PluginFrameProps } from "@interview-os/ui";

type Scores = Record<string, { score: number | null }>;

function Overview({ sdk }: PluginFrameProps) {
  const [scores, setScores] = useState<Scores>({});
  useEffect(() => {
    void sdk.getData().then((d) => setScores((d.readiness as Scores) ?? {}));
  }, [sdk]);
  return (
    <Card>
      <CardTitle>Readiness</CardTitle>
      {Object.entries(scores).map(([id, s]) => (
        <SkillScore key={id} skillId={id} score={s.score} />
      ))}
    </Card>
  );
}

export default {
  components: { overview: Overview },
} satisfies PluginFrameModule;
`;

function createSkill(name, parent, { ui = false } = {}) {
  if (!NAME_RE.test(name)) {
    fail(`invalid name "${name}" — must match ${NAME_RE}`);
  }
  const dir = path.join(parent, name);
  if (fs.existsSync(dir)) fail(`refusing to overwrite existing directory ${dir}`);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  for (const [file, tpl] of Object.entries(TEMPLATES)) {
    fs.writeFileSync(path.join(dir, file), tpl(name));
  }
  if (ui) {
    const yamlPath = path.join(dir, "skill.yaml");
    fs.writeFileSync(
      yamlPath,
      fs.readFileSync(yamlPath, "utf8") + "\n" + UI_MANIFEST_BLOCK,
    );
    fs.mkdirSync(path.join(dir, "ui", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ui", "src", "index.tsx"), UI_ENTRY);
    console.log("  added ui/src/index.tsx — build with `interview-os build-ui .`");
  }
  console.log(`created ${dir}`);
}

/** Bundle <dir>/ui/src/index.tsx → <dir>/ui/index.js (imports stay external). */
async function buildUI(dir) {
  const entry = path.join(dir, "ui", "src", "index.tsx");
  if (!fs.existsSync(entry)) fail(`no ui/src/index.tsx in ${dir}`);
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    platform: "browser",
    outfile: path.join(dir, "ui", "index.js"),
    external: [
      "@interview-os/ui",
      "react",
      "react/jsx-runtime",
      "react-dom/client",
    ],
    logLevel: "warning",
  });
  console.log(`built ${path.join(dir, "ui", "index.js")}`);
}

/** Bundle <dir>/index.ts (+ npm deps) → <dir>/dist/index.js for the backend. */
async function buildPlugin(dir) {
  const candidates = ["index.ts", "index.js", "index.mjs"];
  const entry = candidates.find((f) => fs.existsSync(path.join(dir, f)));
  if (!entry) fail(`no index.ts/index.js entry in ${dir}`);
  const esbuild = await import("esbuild");
  const outfile = path.join(dir, "dist", "index.js");
  await esbuild.build({
    entryPoints: [path.join(dir, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile,
    external: ["@interview-os/plugin-sdk", "@interview-os/core", "@interview-os/ui"],
    logLevel: "warning",
  });
  console.log(`built ${outfile}`);
}

/** Print the committed JSON Schema for skill.yaml (generated by tests). */
function printSchema() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const schemaPath = path.join(here, "..", "schema", "skill.schema.json");
  if (!fs.existsSync(schemaPath)) fail("schema/skill.schema.json missing — run tests to regenerate");
  process.stdout.write(fs.readFileSync(schemaPath, "utf8") + "\n");
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "." },
    ui: { type: "boolean", default: false },
  },
});
const [command, arg] = positionals;

if (command === "create-skill") {
  if (!arg) fail("usage: interview-os create-skill <name> [--dir <parent>] [--ui]");
  createSkill(arg, values.dir, { ui: values.ui });
} else if (command === "validate") {
  if (!arg) fail("usage: interview-os validate <dir>");
  validateDir(arg);
} else if (command === "build-ui") {
  if (!arg) fail("usage: interview-os build-ui <pluginDir>");
  await buildUI(path.resolve(arg));
} else if (command === "build") {
  if (!arg) fail("usage: interview-os build <pluginDir>");
  await buildPlugin(path.resolve(arg));
} else if (command === "schema") {
  printSchema();
} else {
  fail("usage: interview-os <create-skill|validate|build|build-ui|schema> …");
}
