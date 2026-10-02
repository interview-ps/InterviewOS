import { spawnCommand } from "../process/launch.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { RuntimeError } from "../interface/index.js";
import { buildOpencodeChildEnv } from "./childEnv.js";

export interface OpencodeRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Test seam: runs the opencode CLI and resolves with its output. */
export type OpencodeRunner = (
  args: string[],
  opts: { timeoutMs: number; stdin?: string },
) => Promise<OpencodeRunResult>;

export interface OpencodeRunOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
  args: string[];
  /** Untrusted prompt text — written to the child's stdin, never argv. */
  stdin?: string;
  timeoutMs: number;
  runner?: OpencodeRunner;
}

/**
 * Run `opencode <args>` once and collect stdout/stderr. Untrusted prompt text is
 * written to stdin (never an argv element or shell string); the child env is an
 * allowlist. A timeout kills the process and resolves with `code: null`.
 */
export function runOpencodeCli(opts: OpencodeRunOptions): Promise<OpencodeRunResult> {
  if (opts.runner) return opts.runner(opts.args, { timeoutMs: opts.timeoutMs, stdin: opts.stdin });
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCommand(opts.bin, opts.args, {
        cwd: opts.workspaceDir,
        env: buildOpencodeChildEnv(opts.env),
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

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export function cliTimeoutError(timeoutMs: number): RuntimeError {
  return new RuntimeError("TIMEOUT", `opencode did not finish within ${timeoutMs}ms`);
}
