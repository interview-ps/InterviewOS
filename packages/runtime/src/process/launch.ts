import { execFile, spawn } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

const WINDOWS_SHIM = /\.(cmd|bat)$/i;
const NODE_SCRIPT = /\.(mjs|cjs|js)$/i;

function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Windows cannot spawn `.cmd`/`.bat` shims directly with `shell:false`
 * (Node >=20.12 hardens against it and throws EINVAL) and cannot execute a
 * Node script (`.mjs`/`.cjs`/`.js`) as a binary at all (EFTYPE). `.cmd`/`.bat`
 * run through `cmd.exe /d /s /c`; Node scripts run through the current Node
 * binary. `.exe` files and all non-Windows binaries are launched directly.
 * Arguments are always passed as an array — never a single concatenated
 * string — so untrusted values are never interpreted by a shell.
 */
export function launchSpec(
  bin: string,
  args: string[],
): { command: string; args: string[] } {
  if (NODE_SCRIPT.test(bin)) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  if (process.platform === "win32" && WINDOWS_SHIM.test(bin)) {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    const line = [bin, ...args].map(quoteWindowsArg).join(" ");
    return { command: comspec, args: ["/d", "/s", "/c", line] };
  }
  return { command: bin, args };
}

export function spawnCommand(
  bin: string,
  args: string[],
  options: Parameters<typeof spawn>[2] & { stdio: "pipe" | ["pipe", "pipe", "pipe"] },
): ChildProcessWithoutNullStreams;
export function spawnCommand(
  bin: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess;
export function spawnCommand(
  bin: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  const spec = launchSpec(bin, args);
  return spawn(spec.command, spec.args, options);
}

/**
 * Promise wrapper around `execFile` that also catches the synchronous throw
 * Node raises when a `.cmd`/`.bat` cannot be spawned. A detection probe must
 * degrade to "unavailable", never crash the process.
 */
export function execFileSafe(
  bin: string,
  args: string[],
  options: ExecFileOptions,
  callback: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  const spec = launchSpec(bin, args);
  try {
    execFile(
      spec.command,
      spec.args,
      options,
      (err, stdout, stderr) => callback(err, String(stdout), String(stderr)),
    );
  } catch (err) {
    callback(err instanceof Error ? err : new Error(String(err)), "", "");
  }
}
