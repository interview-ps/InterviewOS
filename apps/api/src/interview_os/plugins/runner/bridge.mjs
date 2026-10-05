// bridge.mjs — trusted host bridge between the Python plugin executor and the
// sandboxed Node plugin runner (`runner.mjs`).
//
// The sandboxed runner talks to its parent over Node IPC (`process.send`),
// which a Python parent cannot drive. This bridge — host code, trusted, NOT
// sandboxed — is therefore the runner's direct parent: it forks `runner.mjs`
// with the exact `--permission` sandbox the executor used to pass inline, keeps
// the forked runner's `process.send` working verbatim, and relays
// newline-delimited JSON between the Python side (stdin/stdout) and the child
// (IPC).
//
// Protocol (one JSON object per line):
//   Python stdin           → child.send(message)
//   child "message"        → Python stdout
//   child "close"/"error"  → {"type":"exit","code":<code>}
//
// Usage: node bridge.mjs <pluginDir> <entryFile> <sdkMockHelpersUrl> [sdkMockHelpersPath]
import { fork } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(RUNNER_DIR, "runner.mjs");

const [pluginDir, entryFile, sdkMockHelpersUrl, sdkMockHelpersPathArg] =
  process.argv.slice(2);
if (!pluginDir || !entryFile) {
  process.stderr.write("bridge: missing pluginDir/entryFile arguments\n");
  process.exit(2);
}

// The executor passes the mock-helpers URL (so the runner can map the bare
// specifier onto it); `--allow-fs-read` needs the path form, so derive it here
// unless the caller passed one explicitly.
let sdkMockHelpersPath = sdkMockHelpersPathArg;
if (!sdkMockHelpersPath && sdkMockHelpersUrl) {
  try {
    sdkMockHelpersPath = fileURLToPath(sdkMockHelpersUrl);
  } catch {
    sdkMockHelpersPath = undefined;
  }
}

const execArgv = [
  "--permission",
  `--allow-fs-read=${pluginDir}`,
  `--allow-fs-read=${RUNNER_DIR}`,
];
if (sdkMockHelpersPath) execArgv.push(`--allow-fs-read=${sdkMockHelpersPath}`);

const child = fork(RUNNER_PATH, [pluginDir, entryFile, sdkMockHelpersUrl ?? ""], {
  execArgv,
  cwd: pluginDir,
  env: {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});

const write = (value) => {
  try {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch {
    /* parent gone */
  }
};

let exited = false;
const reportExit = (code) => {
  if (exited) return;
  exited = true;
  write({ type: "exit", code: code ?? null });
};

// child → Python
child.on("message", (message) => write(message));
// Forward the sandboxed runner's stderr so the Python side can log its bytes.
child.stderr?.on("data", (chunk) => {
  try {
    process.stderr.write(chunk);
  } catch {
    /* parent gone */
  }
});
child.on("error", (err) => {
  if (exited) return;
  exited = true;
  write({
    type: "exit",
    code: null,
    error: String(err?.message ?? err).slice(0, 300),
  });
});
child.on("close", (code) => reportExit(code));

// Python → child: one JSON object per line on stdin.
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  try {
    child.send(message);
  } catch {
    /* child gone */
  }
});
rl.on("close", () => {
  try {
    if (!child.killed) child.kill();
  } catch {
    /* ignore */
  }
});
