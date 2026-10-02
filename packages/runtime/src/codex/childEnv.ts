const EXACT_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "CODEX_HOME",
  "OPENAI_API_KEY",
]);

const PREFIX_ALLOWLIST = ["XDG_"];

/**
 * Builds the environment passed to Codex child processes. Only allowlisted
 * variables are forwarded — never the full process.env, never logged.
 * `extraKeys`/`extraPrefixes` exist for tests (e.g. the fake-codex fixture).
 */
export function buildChildEnv(
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
