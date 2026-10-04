import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "@interview-os/core";
import type { AppEnv } from "../context.js";
import { DEFAULT_UI_RUNTIME_DIR } from "../../paths.js";

export const uiRoutes = new Hono<AppEnv>();

/** v0.4: UI contributions of enabled + compatible plugins (nav, commands,
 *  slots, pages, interview modes). Disabled plugins contribute nothing. */
uiRoutes.get("/ui/contributions", async (c) =>
  c.json({ contributions: await c.var.orchestrator.listUIContributions() }),
);

const RUNTIME_FILES: Record<string, string> = {
  "plugin-runtime.js": "text/javascript; charset=utf-8",
  "plugin-runtime.css": "text/css; charset=utf-8",
};

/** v0.4 Level 2: the built iframe runtime bundle (packages/ui build:runtime). */
uiRoutes.get("/ui/runtime/:file", async (c) => {
  const file = c.req.param("file");
  const type = RUNTIME_FILES[file];
  if (!type) throw new AppError("NOT_FOUND", `unknown runtime file "${file}"`);
  const dir = process.env.INTERVIEW_OS_UI_RUNTIME_DIR ?? DEFAULT_UI_RUNTIME_DIR;
  const target = path.join(dir, file);
  const data = await fs.readFile(target).catch(() => {
    throw new AppError(
      "UNAVAILABLE",
      "plugin UI runtime is not built — run `pnpm --filter @interview-os/ui build:runtime`",
    );
  });
  return c.newResponse(new Uint8Array(data), 200, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    // the consumer is an opaque-origin sandbox document: module fetches need
    // CORS, and no-cors fetches need CORP≠same-origin. These are static host
    // assets — deliberately world-readable.
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": "*",
  });
});
