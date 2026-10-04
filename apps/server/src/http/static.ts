import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import type { AppEnv } from "./context.js";

const isApiPath = (p: string) => p === "/api" || p.startsWith("/api/");

/**
 * Serve the built SPA from `webDir` (absolute path, cwd-independent).
 * GET/HEAD for a real file serves it; any other non-/api GET falls back to
 * index.html so client-side routes load. /api/* is untouched — unknown API
 * paths keep the normal 404.
 */
export function mountStaticWeb(app: Hono<AppEnv>, webDir: string) {
  const root = path.resolve(webDir);
  const files = serveStatic<AppEnv>({ root });
  const index = serveStatic<AppEnv>({ root, path: "index.html" });

  app.use("*", async (c, next) => {
    if (isApiPath(c.req.path)) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    return files(c, next);
  });

  app.get("*", async (c) => {
    if (isApiPath(c.req.path)) return c.notFound();
    return (await index(c, () => Promise.resolve())) ?? c.notFound();
  });
}
