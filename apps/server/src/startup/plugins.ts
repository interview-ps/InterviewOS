import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isWritePermission,
  SkillManifestSchema,
  type SkillManifest,
} from "@interview-os/core";
import type { InterviewOrchestrator } from "@interview-os/orchestrator";
import type { PluginExecutor } from "@interview-os/skills";
import type { Logger } from "@interview-os/shared";

export interface PluginLoadError {
  dir: string;
  file: string;
  error: string;
}

/**
 * §9.6: scan a plugins directory at server start. Each subdirectory needs a
 * `manifest.json` (Zod-validated, kind forced to "plugin") and an
 * `index.js`/`index.ts` default-exporting `{ execute(input, ctx) }`.
 * Manifests requesting write permissions are rejected with a warning.
 */
export async function loadPlugins(
  dir: string,
  orchestrator: InterviewOrchestrator,
  logger: Logger,
): Promise<PluginLoadError[]> {
  const errors: PluginLoadError[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return errors; // no plugins directory — fine
  }

  for (const entry of entries.filter((e) => e.isDirectory())) {
    const pluginDir = path.join(dir, entry.name);
    const fail = (file: string, error: string) => {
      errors.push({ dir: entry.name, file, error });
      logger.warn("plugin.load_failed", { plugin: entry.name, file, error });
    };

    let manifestRaw: string;
    try {
      manifestRaw = await fs.readFile(
        path.join(pluginDir, "manifest.json"),
        "utf8",
      );
    } catch {
      fail("manifest.json", "missing or unreadable");
      continue;
    }

    let manifest: SkillManifest;
    try {
      manifest = SkillManifestSchema.parse({
        ...(JSON.parse(manifestRaw) as object),
        kind: "plugin",
      });
    } catch (err) {
      fail(
        "manifest.json",
        `invalid manifest: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      );
      continue;
    }

    const writePerm = manifest.permissions.find((p) => isWritePermission(p));
    if (writePerm) {
      fail(
        "manifest.json",
        `requests write permission "${writePerm}" — plugins are read-only, skipped`,
      );
      continue;
    }

    const entryFile = await (async () => {
      for (const name of ["index.js", "index.ts"]) {
        try {
          await fs.access(path.join(pluginDir, name));
          return name;
        } catch {
          /* try next */
        }
      }
      return null;
    })();
    if (!entryFile) {
      fail("index.{js,ts}", "missing entry file");
      continue;
    }

    try {
      const mod = (await import(
        pathToFileURL(path.join(pluginDir, entryFile)).href
      )) as { default?: PluginExecutor };
      const executor = mod.default;
      if (!executor || typeof executor.execute !== "function") {
        fail(entryFile, "default export must be { execute(input, ctx) }");
        continue;
      }
      orchestrator.registerPlugin(manifest, executor);
      logger.info("plugin.loaded", {
        plugin: manifest.id,
        version: manifest.version,
        inputs: manifest.inputs.map((i) => i.key).join(","),
      });
    } catch (err) {
      fail(
        entryFile,
        `load failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      );
    }
  }
  return errors;
}
