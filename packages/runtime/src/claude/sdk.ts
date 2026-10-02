import type {
  ModelInfo as SdkModelInfo,
  Options as SdkOptions,
  PermissionMode as SdkPermissionMode,
  Query as SdkQuery,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeSdkOptions = SdkOptions;
export type ClaudeSdkMessage = SDKMessage;
export type ClaudeSdkQuery = SdkQuery;
export type ClaudeSdkPermissionMode = SdkPermissionMode;
export type ClaudeSdkModelInfo = SdkModelInfo;

export interface ClaudeSdk {
  query(params: { prompt: string; options?: ClaudeSdkOptions }): ClaudeSdkQuery;
}

/**
 * Thin seam over `@anthropic-ai/claude-agent-sdk` so tests can inject a fake
 * without spawning the real Claude Code binary.
 */
export const realClaudeSdk: ClaudeSdk = {
  query: (params) => sdkQuery(params),
};
