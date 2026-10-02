import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeStatus } from "../interface/index.js";

export const CODEX_SETUP_MESSAGE =
  "Codex CLI not found. Install: npm i -g @openai/codex, then run `codex login`.";

function candidateNames(): string[] {
  return process.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
}

export async function findCodexExecutable(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const override = env.INTERVIEW_OS_CODEX_BIN;
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

export async function getCodexVersion(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return resolve(undefined);
      const text = `${stdout}\n${stderr}`;
      const match = text.match(/codex-cli\s+([0-9][^\s]*)/) ?? text.match(/(\d+\.\d+\.\d+)/);
      resolve(match?.[1]);
    });
  });
}

export async function codexHealthCheck(
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
): Promise<RuntimeStatus> {
  const executable = await findCodexExecutable(env);
  if (!executable) {
    return {
      runtime: "codex",
      available: false,
      workspace: workspaceDir,
      status: "unavailable",
      message: CODEX_SETUP_MESSAGE,
    };
  }
  const version = await getCodexVersion(executable);
  if (!version) {
    return {
      runtime: "codex",
      available: false,
      executable,
      workspace: workspaceDir,
      status: "error",
      message: `Found Codex at ${executable} but \`--version\` failed or timed out. ${CODEX_SETUP_MESSAGE}`,
    };
  }
  return {
    runtime: "codex",
    available: true,
    version,
    executable,
    workspace: workspaceDir,
    status: "ready",
    message: `codex-cli ${version}`,
  };
}
