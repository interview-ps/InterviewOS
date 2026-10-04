import { AppError, newId, type ExternalContext } from "@interview-os/core";
import type { McpManager } from "../mcp/McpManager.js";
import type { WorkflowContext } from "./context.js";

export interface McpServerView {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  /** Env var NAMES only — values never leave the process. */
  envPassthrough: string[];
  enabled: boolean;
  allowedTools: string[];
}

export class McpService {
  constructor(
    private readonly ctx: WorkflowContext,
    private readonly manager: McpManager | undefined,
  ) {}

  private get store() {
    return this.ctx.store;
  }

  private requireManager(): McpManager {
    if (!this.manager) {
      throw new AppError("VALIDATION", "MCP is not configured on this orchestrator");
    }
    return this.manager;
  }

  async listMcpServers(): Promise<{ servers: McpServerView[]; loadError: string | null }> {
    if (!this.manager) return { servers: [], loadError: null };
    const { config, loadError } = this.manager.load();
    const states = new Map(
      (await this.store.listMcpServers()).map((r) => [r.id, r]),
    );
    return {
      loadError,
      servers: config.servers.map((s) => {
        const state = states.get(s.id);
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          command: s.command,
          args: s.args,
          envPassthrough: s.envPassthrough,
          enabled: (state?.enabled ?? 0) === 1,
          allowedTools: (state?.allowedTools as string[] | undefined) ?? [],
        };
      }),
    };
  }

  async updateMcpServer(
    id: string,
    patch: { enabled?: boolean; allowedTools?: string[] },
  ): Promise<McpServerView> {
    const manager = this.requireManager();
    const config = manager.serverConfig(id);
    if (!config) throw new AppError("NOT_FOUND", `no MCP server "${id}"`);
    const row = await this.store.getMcpServer(id);
    const enabled = patch.enabled ?? ((row?.enabled ?? 0) === 1);
    const allowedTools =
      patch.allowedTools ?? ((row?.allowedTools as string[] | undefined) ?? []);
    for (const tool of allowedTools) {
      if (typeof tool !== "string" || tool.length === 0 || tool.length > 64) {
        throw new AppError("VALIDATION", "allowedTools entries must be 1–64 chars");
      }
    }
    // When the (new) state is enabled, validate tool names against a live
    // listTools; an unreachable server still accepts the names.
    if (enabled && patch.allowedTools) {
      try {
        const live = new Set((await manager.probeTools(id)).map((t) => t.name));
        for (const tool of allowedTools) {
          if (!live.has(tool)) {
            throw new AppError(
              "VALIDATION",
              `tool "${tool}" is not exposed by MCP server "${id}"`,
            );
          }
        }
      } catch (err) {
        if (err instanceof AppError && err.code === "VALIDATION") throw err;
        this.ctx.logger.warn("mcp.probe_failed", { server: id });
      }
    }
    await this.store.upsertMcpServer({
      id,
      enabled: enabled ? 1 : 0,
      allowedTools,
      updatedAt: this.ctx.iso(),
    });
    if (!enabled) await manager.disconnect(id);
    this.ctx.logger.info("mcp.updated", { server: id, enabled });
    return {
      id,
      name: config.name,
      description: config.description,
      command: config.command,
      args: config.args,
      envPassthrough: config.envPassthrough,
      enabled,
      allowedTools,
    };
  }

  async listMcpTools(id: string) {
    return this.requireManager().listTools(id);
  }

  async fetchExternalContext(input: {
    serverId: string;
    tool: string;
    args?: Record<string, unknown>;
    title?: string;
  }): Promise<ExternalContext> {
    const manager = this.requireManager();
    const text = await manager.callTool(input.serverId, input.tool, input.args ?? {});
    const config = manager.serverConfig(input.serverId);
    const context: ExternalContext = {
      id: newId("ctx"),
      serverId: input.serverId,
      tool: input.tool,
      title: input.title ?? `${config?.name ?? input.serverId}: ${input.tool}`,
      text,
      createdAt: this.ctx.iso(),
    };
    await this.store.insertExternalContext(context);
    return context;
  }

  listExternalContexts(): Promise<ExternalContext[]> {
    return this.store.listExternalContexts() as Promise<ExternalContext[]>;
  }

  async deleteExternalContext(id: string): Promise<void> {
    const row = await this.store.getExternalContext(id);
    if (!row) throw new AppError("NOT_FOUND", `no external context ${id}`);
    await this.store.deleteExternalContext(id);
  }
}
