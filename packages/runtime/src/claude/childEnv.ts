const EXACT_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
]);

const PREFIX_ALLOWLIST = ["XDG_", "ANTHROPIC_"];

/**
 * Builds the environment passed to the Claude Code child. Only allowlisted
 * variables are forwarded — never the full process.env, never logged.
 * `extraKeys`/`extraPrefixes` exist for tests.
 */
export function buildClaudeChildEnv(
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
