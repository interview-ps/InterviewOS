// Playwright webServer launcher: fresh DB → build the SPA → run the API
// server (which serves UI + API). Plain spawn/spawnSync, no shell — works on
// Windows and POSIX alike.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const db = process.env.INTERVIEW_OS_DB;
if (db) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(db + suffix, { force: true });
  }
}

const require = createRequire(path.join(repo, "apps/web/package.json"));
const viteBin = path.join(
  path.dirname(require.resolve("vite/package.json")),
  "bin/vite.js",
);
const build = spawnSync(process.execPath, [viteBin, "build"], {
  cwd: path.join(repo, "apps/web"),
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(
  process.execPath,
  ["--import", "tsx", "apps/server/src/index.ts"],
  { cwd: repo, stdio: "inherit", env: process.env },
);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.kill(sig));
}
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
