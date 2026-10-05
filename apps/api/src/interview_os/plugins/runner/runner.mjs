import { pathToFileURL, fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import path from "node:path";

const [pluginDir, entryFile, sdkMockHelpersUrl] = process.argv.slice(2);
if (!pluginDir || !entryFile) {
  process.stderr.write("runner: missing pluginDir/entryFile arguments\n");
  process.exit(2);
}

for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
  try {
    delete globalThis[name];
  } catch {
    /* non-configurable on some runtimes */
  }
  if (globalThis[name] !== undefined) {
    try {
      Object.defineProperty(globalThis, name, { value: undefined });
    } catch {
      /* best effort — the fs/permission layer is the real boundary */
    }
  }
}

const BLOCKED_MODULES = new Set([
  "net",
  "http",
  "https",
  "http2",
  "tls",
  "dgram",
  "dns",
  "child_process",
  "worker_threads",
  "cluster",
  "vm",
  "inspector",
  // module itself is blocked for plugin code: import("node:module") +
  // registerHooks() would install hooks that run before ours and could
  // short-circuit a blocked specifier back to a real module.
  "module",
  "wasi",
  "repl",
]);

const sdkShimUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "sdk-shim.mjs"),
).href;

// kill the internal binding/dlopen escape hatches before any plugin code runs
for (const prop of ["binding", "_linkedBinding", "dlopen"]) {
  try {
    process[prop] = () => {
      throw new Error(`plugin isolation: process.${prop} is not available`);
    };
  } catch {
    /* non-writable on some runtimes — module blocks still apply */
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@interview-os/plugin-sdk") {
      return { url: sdkShimUrl, shortCircuit: true };
    }
    // The deterministic mock helpers ship in the SDK and are granted fs-read
    // by the executor — pure functions, no module imports of their own.
    if (specifier === "@interview-os/plugin-sdk/mock-helpers" && sdkMockHelpersUrl) {
      return { url: sdkMockHelpersUrl, shortCircuit: true };
    }
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (BLOCKED_MODULES.has(bare)) {
      throw new Error(`plugin isolation: module "${specifier}" is not available`);
    }
    return nextResolve(specifier, context);
  },
});

const send = (msg) => {
  try {
    process.send?.(msg);
  } catch {
    /* parent gone */
  }
};

const pending = new Map();
let taskSeq = 0;

const ipcRuntime = {
  runTask(task) {
    const id = `t${++taskSeq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "runTask", id, task });
    });
  },
};

const log = (msg) => send({ type: "log", message: String(msg).slice(0, 500) });

const deniedRuntime = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      const err = new Error("plugin lacks runtime.invoke");
      err.code = "PERMISSION_DENIED";
      throw err;
    },
  },
);

const ipcStorage = {
  get(key) {
    const id = `s${++taskSeq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "storage", op: "get", id, key });
    });
  },
  set(key, value) {
    const id = `s${++taskSeq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "storage", op: "set", id, key, value });
    });
  },
  delete(key) {
    const id = `s${++taskSeq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "storage", op: "delete", id, key });
    });
  },
};

let modulePromise = null;
const loadModule = () =>
  (modulePromise ??= import(
    pathToFileURL(path.join(pluginDir, entryFile)).href,
  ));

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "run") {
    void runPlugin(msg);
  } else if (msg.type === "describe") {
    void (async () => {
      try {
        const mod = await loadModule();
        const def = mod.default ?? mod;
        send({
          type: "described",
          id: msg.id,
          handlers:
            def && typeof def.handlers === "object" && def.handlers
              ? Object.keys(def.handlers)
              : [],
          hasExecute: !!(def && typeof def.execute === "function"),
        });
      } catch (err) {
        send({
          type: "described",
          id: msg.id,
          handlers: [],
          hasExecute: false,
          error: String(err instanceof Error ? err.message : err).slice(0, 300),
        });
      }
    })();
  } else if (
    msg.type === "runTaskResult" ||
    msg.type === "runTaskError" ||
    msg.type === "storageResult"
  ) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.type === "storageResult") {
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(String(msg.error ?? "storage failed")));
      } else if (msg.type === "runTaskResult") p.resolve(msg.result);
      else p.reject(new Error(String(msg.message ?? "runTask failed")));
    }
  }
});

async function runPlugin(msg) {
  try {
    const mod = await loadModule();
    const def = mod.default ?? mod;
    if (!def || (typeof def.execute !== "function" && !def.handlers)) {
      throw new Error("plugin entry must default-export { execute } or { handlers }");
    }
    const runtime = msg.runtimeInvoke
      ? { runTask: (t) => ipcRuntime.runTask(t) }
      : undefined;
    const hookCtx = {
      input: msg.input ?? {},
      runtime: runtime ?? deniedRuntime,
      settings: msg.settings ?? {},
      storage: ipcStorage,
      log,
    };
    // Plugin API v1: a declared hook dispatches to handlers[hook]; without a
    // handler the legacy execute path sees { kind, ...request } as before.
    const handler = msg.hook && def.handlers ? def.handlers[msg.hook] : undefined;
    let output;
    if (handler) {
      output = await handler(msg.hookRequest ?? {}, hookCtx);
    } else if (def.__interviewOsSkill === 1) {
      output = await def.execute({
        input: msg.input ?? {},
        request: msg.request,
        runtime,
        settings: msg.settings ?? {},
        storage: ipcStorage,
        log,
      });
    } else if (typeof def.execute === "function") {
      output = await def.execute(msg.input ?? {}, {
        runtime: runtime ?? deniedRuntime,
        log,
      });
    } else {
      throw new Error(`plugin has no handler for "${msg.hook ?? "(run)"}"`);
    }
    send({ type: "result", output: output === undefined ? null : output });
  } catch (err) {
    send({
      type: "error",
      message: String(err instanceof Error ? err.message : err).slice(0, 500),
    });
  }
}
