import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  AppError,
  McpConfigSchema,
  type McpConfig,
  type McpServerConfig,
} from "@interview-os/core";
import { INTERVIEW_OS_VERSION, type Logger } from "@interview-os/core";

const MAX_OUTPUT_CHARS = 12_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_ARGS_BYTES = 4096;

/** Minimal child env: OS essentials + explicitly configured passthrough names. */
function childEnv(config: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const basics = [
    "PATH",
    "SystemRoot",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ];
  for (const name of [...basics, ...config.envPassthrough]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export interface McpServerState {
  enabled: boolean;
  allowedTools: string[];
}

/**
 * Owns MCP config (local file only — never HTTP) and lazy stdio clients.
 * The manager never logs args, tool results, or env values — ids and tool
 * names only — and never exposes child-process details to the API.
 */
export class McpManager {
  private clients = new Map<string, Client>();
  private connecting = new Map<string, Promise<Client>>();

  constructor(
    private readonly configPath: string,
    private readonly logger: Logger,
    private readonly stateFor: (id: string) => Promise<McpServerState>,
  ) {}

  /** Config load: missing file → no servers; invalid file → surfaced loadError. */
  load(): { config: McpConfig; loadError: string | null } {
    if (!fs.existsSync(this.configPath)) {
      return { config: { servers: [] }, loadError: null };
    }
    try {
      const raw = fs.readFileSync(this.configPath, "utf8");
      const parsed = McpConfigSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          config: { servers: [] },
          loadError: `invalid MCP config: ${issue?.path.join(".")} ${issue?.message}`,
        };
      }
      const ids = new Set<string>();
      for (const s of parsed.data.servers) {
        if (ids.has(s.id)) {
          return {
            config: { servers: [] },
            loadError: `invalid MCP config: duplicate server id "${s.id}"`,
          };
        }
        ids.add(s.id);
      }
      return { config: parsed.data, loadError: null };
    } catch (err) {
      return {
        config: { servers: [] },
        loadError: `invalid MCP config: ${(err as Error).message}`,
      };
    }
  }

  serverConfig(id: string): McpServerConfig | undefined {
    return this.load().config.servers.find((s) => s.id === id);
  }

  private async state(id: string): Promise<{ config: McpServerConfig; state: McpServerState }> {
    const config = this.serverConfig(id);
    if (!config) throw new AppError("NOT_FOUND", `no MCP server "${id}"`);
    const state = await this.stateFor(id);
    if (!state.enabled) {
      throw new AppError("VALIDATION", `MCP server "${id}" is disabled`);
    }
    return { config, state };
  }

  private async client(id: string): Promise<Client> {
    const existing = this.clients.get(id);
    if (existing) return existing;
    const pending = this.connecting.get(id);
    if (pending) return pending;
    const task = (async () => {
      const config = this.serverConfig(id);
      if (!config) throw new AppError("NOT_FOUND", `no MCP server "${id}"`);
      const client = new Client(
        { name: "interview-os", version: INTERVIEW_OS_VERSION },
        {},
      );
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: childEnv(config),
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => {
        /* child stderr is untrusted; never forward it */
      });
      try {
        await client.connect(transport);
      } catch (err) {
        throw new AppError(
          "MCP_UNAVAILABLE",
          `MCP server "${id}" could not be reached`,
          { cause: (err as Error).message },
        );
      }
      this.clients.set(id, client);
      return client;
    })();
    this.connecting.set(id, task);
    try {
      return await task;
    } finally {
      this.connecting.delete(id);
    }
  }

  async listTools(id: string): Promise<{ name: string; description?: string }[]> {
    await this.state(id); // requires enabled
    const client = await this.client(id);
    const result = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /** Tool list without the enabled gate — used to validate allowedTools updates. */
  async probeTools(id: string): Promise<{ name: string; description?: string }[]> {
    const client = await this.client(id);
    const result = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /** Returns the joined text parts, truncated to MAX_OUTPUT_CHARS. */
  async callTool(id: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const { state } = await this.state(id);
    if (!state.allowedTools.includes(tool)) {
      throw new AppError(
        "VALIDATION",
        `tool "${tool}" is not in allowedTools for MCP server "${id}"`,
      );
    }
    const argsJson = JSON.stringify(args ?? {});
    if (Buffer.byteLength(argsJson, "utf8") > MAX_ARGS_BYTES) {
      throw new AppError("VALIDATION", "tool args exceed 4 KB");
    }
    const client = await this.client(id);
    this.logger.info("mcp.call", { server: id, tool });
    const result = await client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    const content = (result as { content?: unknown[]; isError?: boolean }).content;
    if ((result as { isError?: boolean }).isError) {
      throw new AppError("MCP_UNAVAILABLE", `tool "${tool}" on "${id}" returned an error`);
    }
    const text = (Array.isArray(content) ? content : [])
      .filter((p): p is { type: string; text: string } =>
        typeof p === "object" && p !== null &&
        (p as { type?: string }).type === "text" &&
        typeof (p as { text?: string }).text === "string")
      .map((p) => p.text)
      .join("\n");
    return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
  }

  /** Forget a cached client (e.g. after state changes) without failing. */
  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (client) {
      try {
        await client.close();
      } catch {
        /* closing is best-effort */
      }
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.disconnect(id)));
  }
}
