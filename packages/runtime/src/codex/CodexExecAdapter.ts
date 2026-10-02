import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "@interview-os/shared";
import {
  RuntimeError,
  type AgentResult,
  type AgentTask,
} from "../interface/index.js";
import { buildChildEnv } from "./childEnv.js";
import { CodexExecEventParser } from "./CodexEventParser.js";

export const DEFAULT_TASK_TIMEOUT_MS = 120_000;
const SIGKILL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 2_048;

export interface CodexExecOptions {
  bin: string;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  /** Test-only escape hatch: additional env keys/prefixes forwarded to the child. */
  extraChildEnv?: { keys?: string[]; prefixes?: string[] };
}

function stderrTail(chunks: Buffer[]): string {
  const tail = Buffer.concat(chunks).subarray(-STDERR_TAIL_BYTES).toString("utf8");
  return tail.trim();
}

function composePrompt(task: AgentTask): string {
  return `${task.instructions}\n\nInput (JSON):\n${JSON.stringify(task.input, null, 2)}\n`;
}

/**
 * One-shot `codex exec --json` adapter. Prompt goes on stdin; output is the
 * JSON.parse of the last `item.completed` agent_message text.
 */
export class CodexExecAdapter {
  constructor(private readonly opts: CodexExecOptions) {}

  async runTask(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    const parser = new CodexExecEventParser();
    const timeoutMs = task.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

    const tmpDir = path.join(this.opts.workspaceDir, ".tmp", `task-${newId("schema")}`);
    const schemaFile = path.join(tmpDir, "output-schema.json");
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(schemaFile, JSON.stringify(task.outputSchema));

    const finish = async (
      result: AgentResult,
    ): Promise<AgentResult> => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return result;
    };

    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s",
      "read-only",
      "-C",
      this.opts.workspaceDir,
      "--output-schema",
      schemaFile,
    ];
    if (task.model) args.push("-m", task.model);
    if (task.effort) args.push("-c", `model_reasoning_effort="${task.effort}"`);
    args.push("-");

    return new Promise<AgentResult>((resolve) => {
      let child;
      try {
        child = spawn(this.opts.bin, args, {
          cwd: this.opts.workspaceDir,
          env: buildChildEnv(this.opts.env, this.opts.extraChildEnv),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        resolve(
          finish({
            ok: false,
            error: new RuntimeError("SPAWN_FAILED", `failed to spawn codex: ${String(err)}`),
            durationMs: Date.now() - started,
            events: parser.events,
          }),
        );
        return;
      }

      const stderrChunks: Buffer[] = [];
      let stdoutBuf = "";
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const settle = (result: AgentResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        resolve(finish(result));
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
      }, timeoutMs);

      child.on("error", (err) => {
        settle({
          ok: false,
          error: new RuntimeError(
            "SPAWN_FAILED",
            `failed to spawn codex: ${err.message}`,
          ),
          durationMs: Date.now() - started,
          events: parser.events,
        });
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        // keep memory bounded
        while (Buffer.concat(stderrChunks).length > STDERR_TAIL_BYTES * 2) {
          stderrChunks.shift();
        }
      });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        let idx;
        while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          parser.feed(line);
        }
      });

      child.on("close", (code, signal) => {
        if (stdoutBuf.trim() !== "") parser.feed(stdoutBuf);
        const durationMs = Date.now() - started;
        const lastMessage = parser.lastAgentMessage;
        const stderr = stderrTail(stderrChunks);

        if (timedOut) {
          settle({
            ok: false,
            error: new RuntimeError(
              "TIMEOUT",
              `codex exec timed out after ${timeoutMs}ms`,
            ),
            durationMs,
            events: parser.events,
          });
          return;
        }

        if (lastMessage !== undefined) {
          try {
            const output = JSON.parse(lastMessage) as unknown;
            settle({
              ok: true,
              output,
              raw: lastMessage,
              durationMs,
              events: parser.events,
            });
          } catch (err) {
            settle({
              ok: false,
              error: new RuntimeError(
                "MALFORMED_OUTPUT",
                `agent_message was not valid JSON: ${(err as Error).message}`,
              ),
              raw: lastMessage,
              durationMs,
              events: parser.events,
            });
          }
          return;
        }

        if (parser.malformedEventCount > 0) {
          settle({
            ok: false,
            error: new RuntimeError(
              "MALFORMED_EVENT",
              `codex emitted ${parser.malformedEventCount} non-JSON stdout line(s) and no agent_message`,
            ),
            durationMs,
            events: parser.events,
          });
          return;
        }

        if (code !== 0 || signal !== null || parser.failedMessage) {
          const why = parser.failedMessage
            ? `turn failed: ${parser.failedMessage}`
            : signal
              ? `codex killed by signal ${signal}`
              : `codex exited with code ${code}`;
          settle({
            ok: false,
            error: new RuntimeError(
              "CRASHED",
              stderr ? `${why} — stderr: ${stderr}` : why,
            ),
            durationMs,
            events: parser.events,
          });
          return;
        }

        settle({
          ok: false,
          error: new RuntimeError(
            "MALFORMED_EVENT",
            "codex exited cleanly but emitted no agent_message event",
          ),
          durationMs,
          events: parser.events,
        });
      });

      child.stdin.write(composePrompt(task), (err) => {
        if (err) {
          settle({
            ok: false,
            error: new RuntimeError("CRASHED", `failed to write prompt: ${err.message}`),
            durationMs: Date.now() - started,
            events: parser.events,
          });
          return;
        }
        child.stdin.end();
      });
    });
  }
}
