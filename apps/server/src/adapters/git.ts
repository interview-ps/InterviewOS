import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "@interview-os/core";

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 120_000;
const CLONE_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Validate an install source: an https URL without credentials or an absolute
 * local path. Never logged — callers must keep the URL out of log lines.
 */
export function validateGitSource(url: string, code = "PLUGIN_INSTALL"): void {
  if (!url || url.startsWith("-") || url.startsWith("ext::")) {
    throw new AppError(code, "invalid git source");
  }
  if (path.isAbsolute(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(code, "source must be an https URL or a local path");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new AppError(code, "source must be an https URL without credentials");
  }
}

/**
 * Shallow-clone `url` into `dest`. URL must already pass validateGitSource.
 * No prompts, no interactive auth, bounded output; argv array, never a shell.
 */
export async function cloneShallow(
  url: string,
  dest: string,
  code = "PLUGIN_INSTALL",
): Promise<void> {
  try {
    await execFileAsync(
      "git",
      [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--depth",
        "1",
        "--no-recurse-submodules",
        "--",
        url,
        dest,
      ],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: CLONE_TIMEOUT_MS,
        maxBuffer: CLONE_MAX_BUFFER,
      },
    );
  } catch {
    throw new AppError(code, "git clone failed");
  }
}
