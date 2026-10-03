import { AppError } from "@interview-os/core";
import type { AIRuntime } from "@interview-os/runtime";
import type { WorkflowContext } from "./context.js";

const TASK_MODES = ["app-server", "exec"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export interface OrchestratorSettings {
  model: string | null;
  reasoningEffort: "low" | "medium" | "high" | null;
  taskMode: TaskMode;
}

export class SettingsService {
  constructor(
    private readonly ctx: WorkflowContext,
    private readonly runtime: AIRuntime,
  ) {}

  async getSettings(): Promise<OrchestratorSettings> {
    const opts = await this.ctx.runtimeOptions();
    return {
      model: opts?.model ?? null,
      reasoningEffort: opts?.effort ?? null,
      taskMode: opts?.taskMode ?? "app-server",
    };
  }

  /**
   * Resolve a saved model against the live catalog. A model that vanished
   * (provider changed / catalog refreshed) falls back to the entry flagged
   * `isDefault` (or the first entry) and is persisted, so the UI never shows a
   * stale id. Returns the effective model.
   */
  private async resolveModelOrDefault(saved: string | null): Promise<string | null> {
    const models = await this.runtime.listModels();
    if (models.length === 0) return saved;
    if (saved && models.some((m) => m.id === saved)) return saved;
    const fallback = models.find((m) => m.isDefault) ?? models[0];
    const next = fallback?.id ?? null;
    if (next !== saved) await this.ctx.store.setSetting("model", next);
    return next;
  }

  async updateSettings(
    patch: Partial<OrchestratorSettings>,
  ): Promise<OrchestratorSettings> {
    if ("model" in patch) {
      const model = patch.model ?? null;
      if (model !== null) {
        await this.ctx.store.setSetting("model", await this.resolveModelOrDefault(model));
      } else {
        await this.ctx.store.setSetting("model", null);
      }
    }
    if ("reasoningEffort" in patch) {
      const effort = patch.reasoningEffort ?? null;
      if (effort !== null) {
        const model = patch.model ?? (await this.ctx.store.getSetting("model")) ?? null;
        if (model !== null) {
          const models = await this.runtime.listModels();
          const m = models.find((x) => x.id === model);
          if (m && m.supportedReasoningEfforts.length > 0 &&
              !m.supportedReasoningEfforts.includes(effort)) {
            throw new AppError(
              "VALIDATION",
              `model "${model}" does not support effort "${effort}"`,
            );
          }
        }
      }
      await this.ctx.store.setSetting("reasoningEffort", effort);
    }
    // taskMode is a Codex-only execution detail; ignore it for other runtimes.
    if ("taskMode" in patch && patch.taskMode !== undefined && this.runtime.kind === "codex") {
      if (!TASK_MODES.includes(patch.taskMode)) {
        throw new AppError("VALIDATION", `invalid taskMode "${patch.taskMode}"`);
      }
      await this.ctx.store.setSetting("taskMode", patch.taskMode);
    }
    return this.getSettings();
  }
}
