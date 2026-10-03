import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const DEFAULT_DB_PATH = path.join(REPO_ROOT, "data/interview-os.db");
export const DEFAULT_PLUGINS_DIR = path.join(REPO_ROOT, "plugins");
export const DEFAULT_EXAMPLES_DIR = path.join(REPO_ROOT, "examples");
