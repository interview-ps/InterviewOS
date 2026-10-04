import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Logger, SkillManifest } from "@interview-os/core";
import {
  PLUGIN_OUTPUT_MAX_BYTES,
  PLUGIN_TIMEOUT_MS,
  PluginError,
  type PluginExecutor,
} from "../skills/index.js";
import type { SkillContext } from "../skills/index.js";

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(RUNNER_DIR, "runner.mjs");

const ChildMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("result"), output: z.unknown() }),
  z.object({ type: z.literal("error"), message: z.string().max(2000) }),
  z.object({
    type: z.literal("runTask"),
    id: z.string().max(64),
    task: z.unknown(),
  }),
  z.object({ type: z.literal("log"), message: z.string().max(1000) }),
  z.object({
    type: z.literal("storage"),
    op: z.enum(["get", "set", "delete"]),
    id: z.string().max(64),
    key: z.string().max(200),
    value: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("described"),
    id: z.string().max(64).optional(),
    handlers: z.array(z.string()),
    hasExecute: z.boolean(),
    error: z.string().optional(),
  }),
]);
type ChildMessage = z.infer<typeof ChildMessageSchema>;

/** Parent side of the plugin KV store — backed by plugin_storage rows. */
export interface PluginStorageAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IsolatedExecutorDeps {
  pluginDir: string;
  entryFile: string;
  manifest: SkillManifest;
  logger?: Logger;
  timeoutMs?: number;
  /** v1: settings values passed to the plugin on every run. */
  getSettings?: () => Promise<Record<string, unknown>>;
  /** v1: the plugin's own KV store (plugin-owned rows, no permission). */
  storage?: PluginStorageAdapter;
}

/**
 * Runs a plugin inside a locked-down child process (`--permission`, fs read
 * limited to the plugin + runner dirs, no env, network globals deleted,
 * dangerous builtin modules blocked by a resolve hook). All communication is
 * JSON over IPC, validated here.
 */
export function createIsolatedExecutor(
  deps: IsolatedExecutorDeps,
): PluginExecutor {
  const { pluginDir, entryFile, manifest, logger } = deps;
  const timeoutMs = deps.timeoutMs ?? PLUGIN_TIMEOUT_MS;

  return {
    async execute(input: Record<string, unknown>, ctx: SkillContext) {
      // the effective grant (manifest ∩ user grant) decides what the child may
      // do; manifest permissions fall back for in-process callers that never
      // set a grant.
      const canInvokeRuntime = (
        ctx.grantedPermissions ?? manifest.permissions
      ).includes("runtime.invoke");
      const child = spawn(
        process.execPath,
        [
          "--permission",
          `--allow-fs-read=${pluginDir}`,
          `--allow-fs-read=${RUNNER_DIR}`,
          RUNNER_PATH,
          pluginDir,
          entryFile,
        ],
        {
          cwd: pluginDir,
          env: {
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );

      // channel may already be gone if the child crashed early — never let a
      // reply throw out of a promise handler.
      const safeSend = (msg: Record<string, unknown>) => {
        try {
          child.send(msg);
        } catch {
          /* child gone */
        }
      };
      const settings =
        ctx.settings ?? (deps.getSettings ? await deps.getSettings() : {});
      safeSend({
        type: "run",
        input,
        request: (input as Record<string, unknown>).request,
        hook: ctx.pluginHook,
        hookRequest: ctx.hookRequest,
        settings,
        runtimeInvoke: canInvokeRuntime,
      });

      let stderrBytes = 0;
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
      });

      return await new Promise<unknown>((resolve, reject) => {
        let settled = false;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.removeAllListeners("message");
          if (!child.killed) child.kill();
          if (stderrBytes > 0) {
            logger?.warn("plugin.stderr", {
              plugin: manifest.id,
              bytes: stderrBytes,
            });
          }
          fn();
        };

        const timer = setTimeout(() => {
          finish(() =>
            reject(
              new PluginError(
                "PLUGIN_TIMEOUT",
                `plugin "${manifest.id}" exceeded ${Math.round(timeoutMs / 1000)}s`,
              ),
            ),
          );
        }, timeoutMs);
        timer.unref?.();

        child.on("error", (err) => {
          finish(() =>
            reject(
              new PluginError(
                "PLUGIN_OUTPUT",
                `plugin "${manifest.id}" could not start (${(err as NodeJS.ErrnoException).code ?? "spawn failed"})`,
              ),
            ),
          );
        });

        child.on("message", (raw) => {
          const parsed = ChildMessageSchema.safeParse(raw);
          if (!parsed.success) return;
          const msg = parsed.data as ChildMessage;
          switch (msg.type) {
            case "log":
              logger?.info("plugin.log", {
                plugin: manifest.id,
                message: msg.message.slice(0, 500),
              });
              break;
            case "storage": {
              const storage = ctx.storage ?? deps.storage;
              const reply = (ok: boolean, value?: unknown, error?: string) =>
                safeSend({ type: "storageResult", id: msg.id, ok, value, error });
              if (!storage) {
                reply(false, undefined, "storage unavailable");
                break;
              }
              const op =
                msg.op === "get"
                  ? storage.get(msg.key)
                  : msg.op === "set"
                    ? storage.set(msg.key, msg.value)
                    : storage.delete(msg.key);
              void Promise.resolve(op)
                .then((value) => reply(true, msg.op === "get" ? value : undefined))
                .catch((err) =>
                  reply(
                    false,
                    undefined,
                    String(err instanceof Error ? err.message : err).slice(0, 300),
                  ),
                );
              break;
            }
            case "result":
              finish(() => resolve(msg.output));
              break;
            case "error":
              finish(() =>
                reject(
                  new PluginError(
                    "PLUGIN_OUTPUT",
                    `plugin "${manifest.id}" failed: ${msg.message.slice(0, 300)}`,
                  ),
                ),
              );
              break;
            case "runTask": {
              if (!canInvokeRuntime) {
                safeSend({
                  type: "runTaskError",
                  id: msg.id,
                  message: "runtime.invoke is not granted to this plugin",
                });
                break;
              }
              // the host's denying-proxy getter can throw synchronously on
              // access — keep every failure as a runTaskError reply, never
              // an uncaught throw out of the message handler.
              let task;
              try {
                task = ctx.runtime.runTask(
                  msg.task as Parameters<SkillContext["runtime"]["runTask"]>[0],
                );
              } catch (err) {
                safeSend({
                  type: "runTaskError",
                  id: msg.id,
                  message: String(err instanceof Error ? err.message : err).slice(0, 300),
                });
                break;
              }
              void Promise.resolve(task)
                .then((result) => {
                  if (result.ok) {
                    safeSend({ type: "runTaskResult", id: msg.id, result });
                  } else {
                    safeSend({
                      type: "runTaskError",
                      id: msg.id,
                      message: result.error.message.slice(0, 300),
                    });
                  }
                })
                .catch((err) => {
                  safeSend({
                    type: "runTaskError",
                    id: msg.id,
                    message: String(err instanceof Error ? err.message : err).slice(0, 300),
                  });
                });
              break;
            }
          }
        });

        // 'close' fires after stdio/IPC have drained — settle any run that
        // produced no result message, including log-only children that exit.
        child.on("close", (code) => {
          if (settled) return;
          finish(() =>
            reject(
              new PluginError(
                "PLUGIN_OUTPUT",
                `plugin "${manifest.id}" exited without a result (code ${code ?? "unknown"})`,
              ),
            ),
          );
        });
      }).then((output) => {
        let serialized: string;
        try {
          serialized = JSON.stringify(output);
        } catch {
          throw new PluginError(
            "PLUGIN_OUTPUT",
            `plugin "${manifest.id}" returned a non-JSON-serializable value`,
          );
        }
        if (serialized === undefined || serialized.length > PLUGIN_OUTPUT_MAX_BYTES) {
          throw new PluginError(
            "PLUGIN_OUTPUT",
            `plugin "${manifest.id}" output exceeds ${PLUGIN_OUTPUT_MAX_BYTES} bytes`,
          );
        }
        return output;
      });
    },

    /** v1: import the plugin in an isolated child and report its handlers. */
    async describe() {
      const child = spawn(
        process.execPath,
        [
          "--permission",
          `--allow-fs-read=${pluginDir}`,
          `--allow-fs-read=${RUNNER_DIR}`,
          RUNNER_PATH,
          pluginDir,
          entryFile,
        ],
        {
          cwd: pluginDir,
          env: {
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      return await new Promise<{ handlers: string[]; hasExecute: boolean }>(
        (resolve) => {
          const timer = setTimeout(() => {
            child.kill();
            resolve({ handlers: [], hasExecute: false });
          }, 10_000);
          timer.unref?.();
          const done = (r: { handlers: string[]; hasExecute: boolean }) => {
            clearTimeout(timer);
            if (!child.killed) child.kill();
            resolve(r);
          };
          child.on("error", () => done({ handlers: [], hasExecute: false }));
          child.on("message", (raw) => {
            const parsed = ChildMessageSchema.safeParse(raw);
            if (!parsed.success || parsed.data.type !== "described") return;
            const d = parsed.data;
            done({ handlers: d.handlers, hasExecute: d.hasExecute });
          });
          child.on("close", () => done({ handlers: [], hasExecute: false }));
          try {
            child.send({ type: "describe", id: "d1" });
          } catch {
            done({ handlers: [], hasExecute: false });
          }
        },
      );
    },
  };
}
