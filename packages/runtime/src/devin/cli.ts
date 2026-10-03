import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnCommand } from "../process/launch.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { RuntimeError } from "../interface/index.js";
import { buildDevinChildEnv } from "./childEnv.js";

export interface DevinRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Test seam: runs the devin CLI and resolves with its output. */
export type DevinRunner = (
  args: string[],
  opts: { timeoutMs: number; prompt?: string },
) => Promise<DevinRunResult>;

export interface DevinRunOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
  args: string[];
  /**
   * Untrusted prompt text — written to a temp file in the workspace and passed
   * via `--prompt-file` (never an argv element, shell string, or stdin: the CLI
   * panics reading `-p` from a pipe).
   */
  prompt?: string;
  timeoutMs: number;
  runner?: DevinRunner;
}

/**
 * Run `devin -p <args>` once and collect stdout/stderr. The prompt travels in a
 * workspace temp file referenced by `--prompt-file` and is deleted afterwards.
 * A timeout kills the process and resolves with `code: null`.
 */
export async function runDevinCli(opts: DevinRunOptions): Promise<DevinRunResult> {
  let promptFile: string | undefined;
  let args = opts.args;
  if (opts.prompt !== undefined) {
    await fs.mkdir(opts.workspaceDir, { recursive: true });
    promptFile = path.join(opts.workspaceDir, `.devin-prompt-${randomUUID()}.txt`);
    await fs.writeFile(promptFile, opts.prompt, "utf8");
    args = [...opts.args, "--prompt-file", promptFile];
  }
  try {
    if (opts.runner) {
      return await opts.runner(args, { timeoutMs: opts.timeoutMs, prompt: opts.prompt });
    }
    return await new Promise<DevinRunResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnCommand(opts.bin, args, {
          cwd: opts.workspaceDir,
          env: buildDevinChildEnv(opts.env),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          code: null,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ stdout, stderr, code });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, opts.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", () => settle(null));
      child.on("exit", (code) => settle(timedOut ? null : code));
      child.stdin.end();
    });
  } finally {
    if (promptFile) await fs.unlink(promptFile).catch(() => {});
  }
}

export function cliTimeoutError(timeoutMs: number): RuntimeError {
  return new RuntimeError("TIMEOUT", `devin did not finish within ${timeoutMs}ms`);
}
