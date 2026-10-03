const EXACT_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  // Windows: Devin CLI reads credentials/config under these roots.
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "WINDSURF_API_KEY",
]);

const PREFIX_ALLOWLIST = ["XDG_", "DEVIN_"];

/**
 * Environment for the spawned `devin` child. Only allowlisted variables are
 * forwarded — never the full process.env, never logged. Devin credentials are
 * read by the CLI from its own auth store (`devin auth login`), so no tokens
 * are forwarded from this process.
 */
export function buildDevinChildEnv(
  env: NodeJS.ProcessEnv,
  extra?: { keys?: string[]; prefixes?: string[] },
): Record<string, string> {
  const keys = new Set([...EXACT_ALLOWLIST, ...(extra?.keys ?? [])]);
  const prefixes = [...PREFIX_ALLOWLIST, ...(extra?.prefixes ?? [])];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (keys.has(key) || prefixes.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
}
