import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "@interview-os/core";
import type { AppEnv } from "../context.js";
import {
  PluginInstallSchema,
  PluginRunSchema,
  PluginSettingsPutSchema,
  PluginUIFrameDataSchema,
  PluginUIFrameRunSchema,
  PluginUIRenderSchema,
  PluginUpdateSchema,
} from "../schemas.js";
import { parseOptionalBody, parseBody } from "../middleware/validate.js";
import { buildFrameDocument } from "../frame-document.js";

export const pluginsRoutes = new Hono<AppEnv>();

pluginsRoutes.get("/", async (c) =>
  c.json({ plugins: await c.var.orchestrator.listPlugins() }),
);

pluginsRoutes.post("/install", async (c) => {
  const { url } = await parseBody(c, PluginInstallSchema);
  return c.json({ plugin: await c.var.orchestrator.installPluginFromGit(url) }, 201);
});

pluginsRoutes.put("/:id", async (c) => {
  const { enabled, grantedPermissions } = await parseBody(c, PluginUpdateSchema);
  return c.json({
    plugin: await c.var.orchestrator.setPluginEnabled(
      c.req.param("id"),
      enabled,
      grantedPermissions,
    ),
  });
});

pluginsRoutes.delete("/:id", async (c) => {
  await c.var.orchestrator.uninstallPlugin(c.req.param("id"));
  return c.json({ ok: true });
});

pluginsRoutes.post("/:id/run", async (c) => {
  const body = await parseOptionalBody(c, PluginRunSchema);
  return c.json(await c.var.orchestrator.runPlugin(c.req.param("id"), body?.request));
});

/** v0.4: render a declared declarative contribution → validated UI tree. */
pluginsRoutes.post("/:id/ui/render", async (c) => {
  const body = await parseBody(c, PluginUIRenderSchema);
  const ui = await c.var.orchestrator.renderPluginUI(c.req.param("id"), body);
  return c.json({ ui });
});

/* -------------------------------------------------- v0.4 Level 2: frames -- */

const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
const UI_ASSET_MAX_BYTES = 2 * 1024 * 1024;

/** Sandboxed iframe document for a declared `kind: "frame"` contribution. */
pluginsRoutes.get("/:id/ui/frame", async (c) => {
  const id = c.req.param("id");
  const component = c.req.query("component");
  const page = c.req.query("page");
  if (component === undefined && page === undefined) {
    throw new AppError("VALIDATION", "component or page query is required");
  }
  const frame = await c.var.orchestrator.resolveUIFrame(id, { component, page });
  const origin = new URL(c.req.url).origin;
  const doc = buildFrameDocument({
    origin,
    pluginId: id,
    entry: frame.entry,
    component: frame.component,
    page: frame.page,
  });
  return c.newResponse(doc.html, 200, doc.headers);
});

/**
 * Static UI assets — files under <pluginDir>/ui/ only, .js/.css/.map only,
 * realpath-confined (symlink-safe), ≤ 2 MB.
 */
pluginsRoutes.get("/:id/ui/assets/*", async (c) => {
  const id = c.req.param("id");
  // enforces enabled + compatible before we ever touch the filesystem.
  const assetRoot = await c.var.orchestrator.resolveUIAssetDir(id);
  const rel = decodeURIComponent(c.req.path.split("/ui/assets/")[1] ?? "");
  if (
    !rel ||
    rel.includes("..") ||
    rel.includes("\\") ||
    rel.startsWith("/") ||
    path.isAbsolute(rel) ||
    /[\x00-\x1f]/.test(rel)
  ) {
    throw new AppError("VALIDATION", "invalid asset path");
  }
  const uiDir = await fs.realpath(assetRoot).catch(() => {
    throw new AppError("NOT_FOUND", `plugin "${id}" has no ui/ directory`);
  });
  const target = await fs
    .realpath(path.join(uiDir, rel))
    .catch(() => {
      throw new AppError("NOT_FOUND", `no ui asset "${rel}"`);
    });
  if (target !== uiDir && !target.startsWith(uiDir + path.sep)) {
    throw new AppError("VALIDATION", "asset escapes the plugin ui/ directory");
  }
  const ext = path.extname(target).toLowerCase();
  const type = ASSET_TYPES[ext];
  if (!type) throw new AppError("VALIDATION", "unsupported asset type");
  const data = await fs.readFile(target);
  if (data.byteLength > UI_ASSET_MAX_BYTES) {
    throw new AppError("VALIDATION", "ui asset exceeds 2 MB");
  }
  return c.newResponse(new Uint8Array(data), 200, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    // see /api/ui/runtime — opaque-origin module fetch needs CORS + CORP.
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": "*",
  });
});

/** The frame's declared + granted data slices (server-assembled). */
pluginsRoutes.post("/:id/ui/data", async (c) => {
  const body = await parseBody(c, PluginUIFrameDataSchema);
  return c.json({
    slices: await c.var.orchestrator.pluginUIData(c.req.param("id"), body),
  });
});

/** Stateless plugin invocation from inside a frame. */
pluginsRoutes.post("/:id/ui/run", async (c) => {
  const body = await parseBody(c, PluginUIFrameRunSchema);
  return c.json(
    await c.var.orchestrator.pluginUIRun(c.req.param("id"), {
      component: body.component,
      page: body.page,
      request: body.request,
    }),
  );
});

/* --------------------------------------------------------- v1 settings --- */

/** Declared settings fields + effective values for a plugin. */
pluginsRoutes.get("/:id/settings", async (c) => {
  const id = c.req.param("id");
  return c.json({
    fields: c.var.orchestrator.pluginSettingsSpec(id),
    values: await c.var.orchestrator.getPluginSettings(id),
  });
});

/** Store settings values — validated against the declared fields. */
pluginsRoutes.put("/:id/settings", async (c) => {
  const body = await parseBody(c, PluginSettingsPutSchema);
  return c.json({
    values: await c.var.orchestrator.setPluginSettings(
      c.req.param("id"),
      body.values,
    ),
  });
});
