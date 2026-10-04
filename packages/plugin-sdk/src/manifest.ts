import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  PLUGIN_INPUT_KEYS,
  SkillManifestSchema,
  SLUG_ID_REGEX,
  isValidVersion,
  type PluginInputKey,
  type SkillManifest,
} from "@interview-os/core";

const MANIFEST_YAML = "skill.yaml";
const MANIFEST_JSON = "manifest.json";
/** dist/index.js (from `interview-os build`) wins over source entries. */
export const PLUGIN_ENTRY_FILES = [
  "dist/index.js",
  "index.ts",
  "index.js",
  "index.mjs",
] as const;

/** Normalize SDK-style `inputs: [candidate, target]` into {key, permission}. */
function normalizeInputs(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((entry) => {
    if (typeof entry !== "string") return entry;
    const permission = PLUGIN_INPUT_KEYS[entry as PluginInputKey];
    if (permission === undefined) {
      throw new Error(`unknown plugin input key "${entry}"`);
    }
    return { key: entry, permission };
  });
}

/** Read + validate `skill.yaml` (preferred) or `manifest.json` in a plugin dir. */
export async function loadManifestFile(dir: string): Promise<SkillManifest> {
  let raw: unknown;
  try {
    raw = YAML.parse(await fs.readFile(path.join(dir, MANIFEST_YAML), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `invalid ${MANIFEST_YAML}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      );
    }
    try {
      raw = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_JSON), "utf8"));
    } catch (jsonErr) {
      throw new Error(
        `missing or invalid ${MANIFEST_YAML}/${MANIFEST_JSON}: ${
          jsonErr instanceof Error ? jsonErr.message.slice(0, 200) : String(jsonErr)
        }`,
      );
    }
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("plugin manifest must be an object");
  }
  const obj: Record<string, unknown> = {
    ...(raw as Record<string, unknown>),
    kind: "plugin",
  };
  obj.inputs = normalizeInputs(obj.inputs);
  const manifest = SkillManifestSchema.parse(obj);
  if (!SLUG_ID_REGEX.test(manifest.id)) {
    throw new Error(
      `plugin id "${manifest.id}" must match ${SLUG_ID_REGEX.source}`,
    );
  }
  manifest.name ??= manifest.id;
  if (!isValidVersion(manifest.version)) {
    throw new Error(
      `plugin "${manifest.id}" version "${manifest.version}" is not valid semver x.y.z`,
    );
  }
  validateUIContributions(manifest);
  return manifest;
}

const FRAME_ENTRY_REGEX = /^ui\/[a-zA-Z0-9][a-zA-Z0-9._\/-]*\.js$/;

/** v0.4: `ui` requires the capability; frame entries must stay under ui/. */
function validateUIContributions(manifest: SkillManifest): void {
  const ui = manifest.ui;
  if (!ui) return;
  if (!(manifest.capabilities ?? []).includes("ui")) {
    throw new Error(
      `plugin "${manifest.id}" declares a "ui" section without the "ui" capability`,
    );
  }
  const contributions = [
    ...Object.values(ui.slots).flat(),
    ...ui.pages.map((p) => ({ component: p.component, kind: p.kind, entry: p.entry })),
  ];
  for (const c of contributions) {
    if (c.kind !== "frame") continue;
    if (!c.entry || !FRAME_ENTRY_REGEX.test(c.entry) || c.entry.includes("..")) {
      throw new Error(
        `plugin "${manifest.id}" frame "${c.component}" needs a safe entry path under ui/ (got "${c.entry ?? ""}")`,
      );
    }
  }
}

export async function findEntryFile(dir: string): Promise<string | null> {
  for (const name of PLUGIN_ENTRY_FILES) {
    try {
      await fs.access(path.join(dir, name));
      return name;
    } catch {
      /* try next */
    }
  }
  return null;
}
