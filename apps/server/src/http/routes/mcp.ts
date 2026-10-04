import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { parseBody } from "../middleware/validate.js";
import { McpContextFetchSchema, McpServerPatchSchema } from "../schemas.js";

/**
 * v0.4 MCP routes. Server commands come only from the local
 * interview-os.mcp.json file — this API can enable/disable servers, allow
 * individual tools and fetch contexts, but can NEVER configure a command.
 */
export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.get("/servers", async (c) =>
  c.json(await c.var.orchestrator.listMcpServers()),
);

mcpRoutes.put("/servers/:id", async (c) => {
  const body = await parseBody(c, McpServerPatchSchema);
  return c.json(
    await c.var.orchestrator.updateMcpServer(c.req.param("id"), body),
  );
});

mcpRoutes.get("/servers/:id/tools", async (c) =>
  c.json({ tools: await c.var.orchestrator.listMcpTools(c.req.param("id")) }),
);

mcpRoutes.get("/contexts", async (c) =>
  c.json(await c.var.orchestrator.listExternalContexts()),
);

mcpRoutes.post("/contexts", async (c) => {
  const body = await parseBody(c, McpContextFetchSchema);
  return c.json(await c.var.orchestrator.fetchExternalContext(body), 201);
});

mcpRoutes.delete("/contexts/:id", async (c) => {
  await c.var.orchestrator.deleteExternalContext(c.req.param("id"));
  return c.json({ ok: true });
});
