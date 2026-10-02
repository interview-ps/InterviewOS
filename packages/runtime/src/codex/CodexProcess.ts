import { type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { RuntimeError } from "../interface/index.js";
import { spawnCommand } from "../process/launch.js";
import { buildChildEnv } from "./childEnv.js";

export const PROCESS_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: RuntimeError) => void;
  timer: NodeJS.Timeout;
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type ExitHandler = (code: number | null, signal: string | null) => void;

const CLIENT_INFO = { name: "interview-os", title: "Interview OS", version: "0.1.0" };

/**
 * Owns one long-lived `codex app-server --listen stdio://` child speaking
 * newline-delimited JSON-RPC (no "jsonrpc" field). Auto-restarts on crash;
 * server→client requests (approvals) are always declined.
 */
export class CodexProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private nextRequestId = 1;
  private ready = false;
  private initializing: Promise<void> | null = null;
  /** Increments every time the underlying child process exits. */
  generation = 0;

  constructor(
    private readonly opts: {
      bin: string;
      workspaceDir: string;
      env: NodeJS.ProcessEnv;
      requestTimeoutMs?: number;
      extraChildEnv?: { keys?: string[]; prefixes?: string[] };
    },
  ) {}

  get isReady(): boolean {
    return this.ready;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (!this.initializing) {
      this.initializing = this.start();
    }
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async start(): Promise<void> {
    this.spawnChild();
    await this.request(
      "initialize",
      { clientInfo: CLIENT_INFO, capabilities: null },
      PROCESS_REQUEST_TIMEOUT_MS,
    );
    this.notify("initialized", {});
    this.ready = true;
  }

  private spawnChild(): void {
    const child = spawnCommand(this.opts.bin, ["app-server", "--listen", "stdio://"], {
      cwd: this.opts.workspaceDir,
      env: buildChildEnv(this.opts.env, this.opts.extraChildEnv),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", () => this.handleExit(null, null));
    child.on("exit", (code, signal) => this.handleExit(code, signal));

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    child.stderr.resume(); // drain; never logged (may contain paths)
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON line on stdout: ignore
    }

    if (msg.id !== undefined && typeof msg.method === "string") {
      // server→client request (approvals etc.): decline, never approve
      this.send({ id: msg.id, error: { code: -32601, message: "declined by interview-os" } });
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pendingReq = this.pending.get(msg.id as number);
      if (!pendingReq) return;
      this.pending.delete(msg.id as number);
      clearTimeout(pendingReq.timer);
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string };
        pendingReq.reject(
          new RuntimeError(
            "PROTOCOL",
            `codex app-server error ${err.code ?? "?"}: ${err.message ?? "unknown"}`,
          ),
        );
      } else {
        pendingReq.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      for (const handler of this.notificationHandlers) {
        handler(msg.method, msg.params);
      }
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new RuntimeError("CRASHED", "codex app-server is not running"));
    }
    const id = this.nextRequestId++;
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? PROCESS_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeError("TIMEOUT", `codex app-server request ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.child === null && this.rl === null) return; // error+exit double-fire
    this.rl?.close();
    this.rl = null;
    this.child = null;
    this.ready = false;
    this.generation += 1;
    const err = new RuntimeError(
      "CRASHED",
      `codex app-server exited (code=${code ?? "?"}, signal=${signal ?? "?"})`,
    );
    for (const [id, pendingReq] of this.pending) {
      clearTimeout(pendingReq.timer);
      pendingReq.reject(err);
      this.pending.delete(id);
    }
    for (const handler of this.exitHandlers) handler(code, signal);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.rl?.close();
    this.rl = null;
    for (const [id, pendingReq] of this.pending) {
      clearTimeout(pendingReq.timer);
      pendingReq.reject(new RuntimeError("CRASHED", "codex app-server closed"));
      this.pending.delete(id);
    }
    if (!child) return;
    // Wait for the OS to reap the child. On Windows an exited-but-unreaped
    // process keeps its workspace cwd locked, so returning immediately races
    // with callers that delete the workspace right after dispose().
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve();
      }, 2000);
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", onExit);
      child.kill("SIGKILL");
    });
  }
}
