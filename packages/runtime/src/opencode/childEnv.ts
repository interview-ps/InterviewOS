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
  "OPENCODE_CONFIG",
]);

const PREFIX_ALLOWLIST = ["XDG_", "OPENCODE_"];

/**
 * Environment for the spawned `opencode serve` child. Only allowlisted
 * variables are forwarded — never the full process.env, never logged. Note
 * provider API keys are read by opencode from its own auth store, so they are
 * deliberately NOT forwarded from this process.
 */
export function buildOpencodeChildEnv(
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
