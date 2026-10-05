#!/usr/bin/env node
// Fake MCP server for Interview OS v0.4 tests (SDK server over stdio).
// Tools:
//   get_repository({ repo }) -> fake README + file tree
//   echo_env()               -> JSON list of env var NAMES visible to the child
//   big_output()             -> 50 KB of text
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-mcp", version: "1.0.0" });

server.registerTool(
  "get_repository",
  {
    description: "Return a fake README and file tree for a repository.",
    inputSchema: { repo: z.string() },
  },
  async ({ repo }) => ({
    content: [
      {
        type: "text",
        text:
          `# ${repo}\n\n` +
          `A sample repository used by tests.\n\n` +
          `## File tree\n- src/index.ts\n- src/api/routes.ts\n- src/store/db.ts\n` +
          `- test/api.test.ts\n- package.json\n- README.md\n\n` +
          `## Architecture\nLayered: routes -> services -> store.`,
      },
    ],
  }),
);

server.registerTool(
  "echo_env",
  { description: "List the NAMES of env vars visible to this process." },
  async () => ({
    content: [
      { type: "text", text: JSON.stringify(Object.keys(process.env).sort()) },
    ],
  }),
);

server.registerTool(
  "big_output",
  { description: "Return a large (50 KB) text blob." },
  async () => ({
    content: [{ type: "text", text: "x".repeat(50 * 1024) }],
  }),
);

await server.connect(new StdioServerTransport());
