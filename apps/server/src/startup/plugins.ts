import fs from "node:fs/promises";
import path from "node:path";
import { isPluginWritable, isWritePermission, SLUG_ID_REGEX, taxonomy } from "@interview-os/core";
import { findEntryFile, loadManifestFile } from "@interview-os/plugin-sdk";
import type { InterviewOrchestrator } from "../orchestrator/index.js";
import type { PluginSource } from "../orchestrator/plugin-service.js";
import { createIsolatedExecutor } from "../plugins/executor.js";
import type { Logger } from "@interview-os/core";

export interface PluginLoadError {
  dir: string;
  file: string;
  error: string;
}

/**
 * §9.6: scan a plugins directory at server start. Each subdirectory needs a
 * `skill.yaml` (preferred) or `manifest.json` and an `index.ts`/`index.js`/
 * `index.mjs` entry; plugins execute in an isolated child process. Manifests
 * requesting a write permission other than evidence.write are rejected.
 */
export async function loadPlugins(
  dir: string,
  orchestrator: InterviewOrchestrator,
  logger: Logger,
  source: PluginSource = "bundled",
): Promise<PluginLoadError[]> {
  const errors: PluginLoadError[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return errors; // no plugins directory — fine
  }

  for (const entry of entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith("."),
  )) {
    const pluginDir = path.join(dir, entry.name);
    const fail = (file: string, error: string) => {
      errors.push({ dir: entry.name, file, error });
      logger.warn("plugin.load_failed", { plugin: entry.name, file, error });
    };

    let manifest;
    try {
      manifest = await loadManifestFile(pluginDir);
    } catch (err) {
      fail(
        "skill.yaml",
        err instanceof Error ? err.message.slice(0, 300) : String(err),
      );
      continue;
    }

    if (!SLUG_ID_REGEX.test(manifest.id)) {
      fail("manifest", `invalid plugin id "${manifest.id}"`);
      continue;
    }

    const writePerm = manifest.permissions.find(
      (p) => isWritePermission(p) && !isPluginWritable(p),
    );
    if (writePerm) {
      fail(
        "manifest",
        `requests write permission "${writePerm}" — plugins may only write evidence, skipped`,
      );
      continue;
    }

    const entryFile = await findEntryFile(pluginDir);
    if (!entryFile) {
      fail("index.{ts,js,mjs}", "missing entry file");
      continue;
    }

    try {
      const executor = createIsolatedExecutor({
        pluginDir,
        entryFile,
        manifest,
        logger,
      });
      // Plugin API v1: ask the isolated runner which handlers it exports so
      // the loader can enforce capability↔hook backing. Best-effort: a
      // describe failure just leaves hooks = manifest-declared.
      const described = await executor.describe?.().catch(() => null);
      orchestrator.registerPlugin(manifest, executor, {
        dir: pluginDir,
        entryFile,
        source,
        hooks: described?.handlers,
      });
      // v0.4: plugin-declared taxonomy nodes register at load (idempotent).
      if (manifest.taxonomy?.length) {
        taxonomy.registerNodes(manifest.taxonomy);
        for (const node of manifest.taxonomy) {
          await orchestrator.registerSkillNode(node.id);
        }
      }
      logger.info("plugin.loaded", {
        plugin: manifest.id,
        version: manifest.version,
        inputs: manifest.inputs.map((i) => i.key).join(","),
      });
    } catch (err) {
      fail(
        entryFile,
        err instanceof Error ? err.message.slice(0, 300) : String(err),
      );
    }
  }
  return errors;
}
