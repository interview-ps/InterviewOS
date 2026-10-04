import { z } from "zod";
import { SlugIdSchema } from "../skills/manifest.js";

/**
 * v0.4 MCP: server definitions live ONLY in a local config file
 * (`<repo>/interview-os.mcp.json`, overridable via INTERVIEW_OS_MCP_CONFIG).
 * They are never accepted over HTTP — that would be a shell exposed to the
 * browser. `envPassthrough` holds env var NAMES (never values); the manager
 * copies only the listed, set variables into the child's minimal environment.
 */

const EnvNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "env var names must be UPPER_SNAKE");

export const McpServerConfigSchema = z.object({
  id: SlugIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(1000)).max(32).default([]),
  envPassthrough: z.array(EnvNameSchema).max(32).default([]),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z.object({
  servers: z.array(McpServerConfigSchema).max(32).default([]),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** Stored, non-secret result of an allowed MCP tool call. */
export const ExternalContextSchema = z.object({
  id: z.string().min(1),
  serverId: SlugIdSchema,
  tool: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  text: z.string().max(50_000),
  createdAt: z.string().min(1),
});
export type ExternalContext = z.infer<typeof ExternalContextSchema>;
