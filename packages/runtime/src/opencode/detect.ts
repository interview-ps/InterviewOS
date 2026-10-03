import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeStatus } from "../interface/index.js";
import { execFileSafe } from "../process/launch.js";
import { buildOpencodeChildEnv } from "./childEnv.js";

export const OPENCODE_SETUP_MESSAGE =
  "opencode not found. Install: npm i -g opencode-ai, then run `opencode auth login`.";

function candidateNames(): string[] {
  return process.platform === "win32"
    ? ["opencode.cmd", "opencode.exe", "opencode"]
    : ["opencode"];
}

export async function findOpencodeExecutable(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const override = env.INTERVIEW_OS_OPENCODE_BIN;
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

export async function getOpencodeVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFileSafe(
      bin,
      ["--version"],
      { timeout: 5000, env: buildOpencodeChildEnv(env), shell: false },
      (err, stdout, stderr) => {
        if (err) return resolve(undefined);
        const text = `${stdout}\n${stderr}`;
        const match = text.match(/(\d+\.\d+\.\d+[^\s]*)/);
        resolve(match?.[1]);
      },
    );
  });
}

export async function opencodeHealthCheck(
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
): Promise<RuntimeStatus> {
  const executable = await findOpencodeExecutable(env);
  if (!executable) {
    return {
      runtime: "opencode",
      available: false,
      workspace: workspaceDir,
      status: "unavailable",
      message: OPENCODE_SETUP_MESSAGE,
    };
  }
  const version = await getOpencodeVersion(executable, env);
  if (!version) {
    return {
      runtime: "opencode",
      available: false,
      executable,
      workspace: workspaceDir,
      status: "error",
      message: `Found opencode at ${executable} but \`--version\` failed or timed out. ${OPENCODE_SETUP_MESSAGE}`,
    };
  }
  return {
    runtime: "opencode",
    available: true,
    version,
    executable,
    workspace: workspaceDir,
    status: "ready",
    message: `opencode ${version}`,
  };
}
