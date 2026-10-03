import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeStatus } from "../interface/index.js";
import { execFileSafe } from "../process/launch.js";
import { buildDevinChildEnv } from "./childEnv.js";

export const DEVIN_SETUP_MESSAGE =
  "Devin CLI not found. Install it from https://devin.ai, then run `devin auth login`.";

function candidateNames(): string[] {
  return process.platform === "win32"
    ? ["devin.exe", "devin.cmd", "devin"]
    : ["devin"];
}

export async function findDevinExecutable(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const override = env.INTERVIEW_OS_DEVIN_BIN;
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

export async function getDevinVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFileSafe(
      bin,
      ["--version"],
      { timeout: 5000, env: buildDevinChildEnv(env), shell: false },
      (err, stdout, stderr) => {
        if (err) return resolve(undefined);
        const text = `${stdout}\n${stderr}`;
        const match = text.match(/(\d+\.\d+\.\d+[^\s]*)/);
        resolve(match?.[1]);
      },
    );
  });
}

export async function devinHealthCheck(
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
): Promise<RuntimeStatus> {
  const executable = await findDevinExecutable(env);
  if (!executable) {
    return {
      runtime: "devin",
      available: false,
      workspace: workspaceDir,
      status: "unavailable",
      message: DEVIN_SETUP_MESSAGE,
    };
  }
  const version = await getDevinVersion(executable, env);
  if (!version) {
    return {
      runtime: "devin",
      available: false,
      executable,
      workspace: workspaceDir,
      status: "error",
      message: `Found devin at ${executable} but \`devin version\` failed or timed out. ${DEVIN_SETUP_MESSAGE}`,
    };
  }
  return {
    runtime: "devin",
    available: true,
    version,
    executable,
    workspace: workspaceDir,
    status: "ready",
    message: `devin ${version}`,
  };
}
