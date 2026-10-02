import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeStatus } from "../interface/index.js";
import { execFileSafe } from "../process/launch.js";
import { buildClaudeChildEnv } from "./childEnv.js";

export const CLAUDE_SETUP_MESSAGE =
  "Claude Code not found. Install: npm i -g @anthropic-ai/claude-code, then run `claude` to log in.";

function candidateNames(): string[] {
  return process.platform === "win32"
    ? ["claude.cmd", "claude.exe", "claude"]
    : ["claude"];
}

export async function findClaudeExecutable(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const override = env.INTERVIEW_OS_CLAUDE_BIN;
  if (override) {
    try {
      await fs.access(override, fsConstants.X_OK);
      return override;
    } catch {
      return undefined;
    }
  }
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of candidateNames()) {
      const candidate = path.join(dir, name);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

export async function getClaudeVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFileSafe(
      bin,
      ["--version"],
      { timeout: 5000, env: buildClaudeChildEnv(env), shell: false },
      (err, stdout, stderr) => {
        if (err) return resolve(undefined);
        const text = `${stdout}\n${stderr}`;
        const match = text.match(/(\d+\.\d+\.\d+[^\s]*)/);
        resolve(match?.[1]);
      },
    );
  });
}

export async function claudeHealthCheck(
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
): Promise<RuntimeStatus> {
  const executable = await findClaudeExecutable(env);
  if (!executable) {
    return {
      runtime: "claude",
      available: false,
      workspace: workspaceDir,
      status: "unavailable",
      message: CLAUDE_SETUP_MESSAGE,
    };
  }
  const version = await getClaudeVersion(executable, env);
  if (!version) {
    return {
      runtime: "claude",
      available: false,
      executable,
      workspace: workspaceDir,
      status: "error",
      message: `Found Claude Code at ${executable} but \`--version\` failed or timed out. ${CLAUDE_SETUP_MESSAGE}`,
    };
  }
  return {
    runtime: "claude",
    available: true,
    version,
    executable,
    workspace: workspaceDir,
    status: "ready",
    message: `claude-code ${version}`,
  };
}
