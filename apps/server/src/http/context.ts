import type { InterviewOrchestrator, Store } from "../orchestrator/index.js";
import type { AIRuntime, RuntimeManager } from "@interview-os/runtime";
import type { Logger } from "@interview-os/core";
import type { Context } from "hono";

export interface AppVariables {
  orchestrator: InterviewOrchestrator;
  runtime: AIRuntime;
  runtimes?: RuntimeManager;
  store?: Store;
  logger: Logger;
  examplesDir: string;
  pluginErrors: { dir: string; file: string; error: string }[];
}

export type AppEnv = { Variables: AppVariables };

export type AppContext = Context<AppEnv>;

export interface AppDeps {
  orchestrator: InterviewOrchestrator;
  runtime: AIRuntime;
  /** When present, enables runtime probing (`GET /api/runtime/available`) and
   * hot-switching (`PUT /api/runtime`); `store` persists the selection. */
  runtimes?: RuntimeManager;
  store?: Store;
  examplesDir?: string;
  logger?: Logger;
  /** §9.6: plugin directories that failed validation/import at startup. */
  pluginErrors?: { dir: string; file: string; error: string }[];
}
